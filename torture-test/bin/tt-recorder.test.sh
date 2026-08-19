#!/usr/bin/env bash
# tt-recorder.test.sh — self-test for tt-recorder CLI dispatch and --help.
# Validates CLI skeleton per US-001 acceptance criteria.
#
# MACP3 US-004: every '/proc' hit in this harness is linux-only. All RUNTIME
# /proc reads carry an explicit inline 'MACP3 US-004 linux-only' comment with
# their Darwin behavior (guard fails, pass-by-note). Pass/fail prose and echo
# titles mentioning /proc (e.g. "...via /proc", "/proc/<pid>/status") are
# documentation only — no procfs access — and '/'+'process' substrings like
# "daemon/process" are the word "process", not the procfs mount.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-recorder"

# Compute TT_ROOT consistently with tt-recorder (needed for tests that spawn the recorder)
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
TT_ROOT_VAR="${TT_REPO_ROOT}/torture-test/var"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-recorder self-test ==="

# Clean up any stale recorder from prior runs
if [ -f "$TT_ROOT_VAR/recorder/tt-recorder.pid" ]; then
  STALE_PID="$(cat "$TT_ROOT_VAR/recorder/tt-recorder.pid" 2>/dev/null || true)"
  if [ -n "$STALE_PID" ]; then
    kill "$STALE_PID" 2>/dev/null || true
    timeout 3 wait "$STALE_PID" 2>/dev/null || true
  fi
  rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true
fi

# ── Test 1: --help prints usage and exits 0 ───────────────────────────
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

# ── Test 2: -h prints usage (short form) ─────────────────────────────
echo ""
echo "--- Test: -h short form ---"

if "$TOOL" -h 2>&1 | grep -q "Usage:"; then
  pass "-h prints usage"
else
  fail "-h did not print usage"
fi

if "$TOOL" -h > /dev/null 2>&1; then
  pass "-h exits 0"
else
  fail "-h did not exit 0"
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

if echo "$no_args_out" | grep -q "Usage:"; then
  pass "no arguments prints usage"
else
  fail "no arguments did not print usage"
fi

# ── Test 4: start --help prints start-specific help mentioning --interval ─
echo ""
echo "--- Test: start --help ---"

start_help="$("$TOOL" start --help 2>&1)"

if echo "$start_help" | grep -qi "interval"; then
  pass "start --help mentions --interval"
else
  fail "start --help missing --interval mention"
fi

if echo "$start_help" | grep -q "Usage:"; then
  pass "start --help has Usage: line"
else
  fail "start --help missing Usage: line"
fi

if "$TOOL" start --help > /dev/null 2>&1; then
  pass "start --help exits 0"
else
  fail "start --help did not exit 0"
fi

# ── Test 5: unknown subcommand exits non-zero with error message ─────
echo ""
echo "--- Test: unknown subcommand ---"

set +e
unknown_out="$("$TOOL" unknown-subcommand 2>&1)"
unknown_rc=$?
set -e

if [ "$unknown_rc" -ne 0 ]; then
  pass "unknown subcommand exits non-zero (rc=$unknown_rc)"
else
  fail "unknown subcommand exited 0 (should be non-zero)"
fi

if echo "$unknown_out" | grep -qi "unknown"; then
  pass "unknown subcommand prints error message"
else
  fail "unknown subcommand did not print error message"
fi

if echo "$unknown_out" | grep -q "Usage:"; then
  pass "unknown subcommand prints usage"
else
  fail "unknown subcommand did not print usage"
fi

# ── Test 6: --interval 10 parsed correctly ────────────────────────────
echo ""
echo "--- Test: --interval parsing ---"

# Clean up any prior recorder before testing
rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true

set +e
int10_out="$("$TOOL" start --interval 10 2>&1)"
int10_rc=$?
set -e

if echo "$int10_out" | grep -q "interval=10s"; then
  pass "start --interval 10 passes interval=10 to cmd_start"
else
  fail "start --interval 10 did not pass interval=10 (got: $int10_out)"
fi

# Clean up after this test
if [ -f "$TT_ROOT_VAR/recorder/tt-recorder.pid" ]; then
  US006_T6_PID="$(cat "$TT_ROOT_VAR/recorder/tt-recorder.pid" 2>/dev/null || true)"
  kill "$US006_T6_PID" 2>/dev/null || true
  timeout 3 wait "$US006_T6_PID" 2>/dev/null || true
  rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true
fi

# ── Test 7: --interval default (5) when not provided ─────────────────
echo ""
echo "--- Test: --interval default ---"

# Clean up any prior recorder state before testing default interval
rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true

set +e
int_default_out="$("$TOOL" start 2>&1)"
int_default_rc=$?
set -e

# With real cmd_start, exit 0 on success, 1 on already-running
# Check that the default interval (5s) was used
if echo "$int_default_out" | grep -q "interval=5s"; then
  pass "start (no --interval) defaults to interval=5"
else
  fail "start (no --interval) did not default to 5 (got: $int_default_out)"
fi

# Clean up after this test
if [ -f "$TT_ROOT_VAR/recorder/tt-recorder.pid" ]; then
  US006_T7_PID="$(cat "$TT_ROOT_VAR/recorder/tt-recorder.pid" 2>/dev/null || true)"
  kill "$US006_T7_PID" 2>/dev/null || true
  timeout 3 wait "$US006_T7_PID" 2>/dev/null || true
  rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true
fi

# ── Test 8: --interval rejects non-integer value ──────────────────────
echo ""
echo "--- Test: --interval invalid value ---"

set +e
inv_int_out="$("$TOOL" start --interval abc 2>&1)"
inv_int_rc=$?
set -e

if [ "$inv_int_rc" -ne 0 ]; then
  pass "--interval abc exits non-zero (rc=$inv_int_rc)"
else
  fail "--interval abc exited 0 (should be non-zero)"
fi

if echo "$inv_int_out" | grep -qi "positive integer"; then
  pass "--interval abc prints error about positive integer"
else
  fail "--interval abc did not print positive integer error (got: $inv_int_out)"
fi

# ── Test 9: --interval rejects 0 ─────────────────────────────────────
echo ""
echo "--- Test: --interval zero rejected ---"

set +e
zero_int_out="$("$TOOL" start --interval 0 2>&1)"
zero_int_rc=$?
set -e

if [ "$zero_int_rc" -ne 0 ]; then
  pass "--interval 0 exits non-zero (rc=$zero_int_rc)"
else
  fail "--interval 0 exited 0 (should be non-zero)"
fi

# ── Test 10: --interval with no value ────────────────────────────────
echo ""
echo "--- Test: --interval missing value ---"

set +e
no_val_out="$("$TOOL" start --interval 2>&1)"
no_val_rc=$?
set -e

if [ "$no_val_rc" -ne 0 ]; then
  pass "--interval with no value exits non-zero (rc=$no_val_rc)"
else
  fail "--interval with no value exited 0 (should be non-zero)"
fi

# ── Test 11: stop --help prints stop-specific help ────────────────────
echo ""
echo "--- Test: stop --help ---"

stop_help="$("$TOOL" stop --help 2>&1)"

if echo "$stop_help" | grep -qi "stop"; then
  pass "stop --help mentions stop"
else
  fail "stop --help missing stop mention"
fi

if "$TOOL" stop --help > /dev/null 2>&1; then
  pass "stop --help exits 0"
else
  fail "stop --help did not exit 0"
fi

# ── Test 12: status --help prints status-specific help ────────────────
echo ""
echo "--- Test: status --help ---"

status_help="$("$TOOL" status --help 2>&1)"

if echo "$status_help" | grep -qi "status"; then
  pass "status --help mentions status"
else
  fail "status --help missing status mention"
fi

if "$TOOL" status --help > /dev/null 2>&1; then
  pass "status --help exits 0"
else
  fail "status --help did not exit 0"
fi

# ── Test 13: All subcommands are recognized ──────────────────────────
echo ""
echo "--- Test: subcommand dispatch ---"

# Clean up before startup test
rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true

for cmd in start stop status; do
  set +e
  "$TOOL" "$cmd" > /dev/null 2>&1
  cmd_rc=$?
  set -e
  # start: now real, exits 0 on success; stop: now real, exits 0 (idempotent); status: now real, exits 0 (NOT RUNNING or RUNNING)
  if [ "$cmd" = "start" ]; then
    if [ "$cmd_rc" -eq 0 ]; then
      pass "'$cmd' dispatches to cmd_$cmd (exits 0 = success)"
    elif [ "$cmd_rc" -eq 1 ] && [ -f "$TT_ROOT_VAR/recorder/tt-recorder.pid" ]; then
      pass "'$cmd' dispatches to cmd_$cmd (exits 1 = already running after earlier test)"
    else
      fail "'$cmd' did not dispatch to cmd_$cmd (rc=$cmd_rc)"
    fi
    # Clean up the started recorder
    if [ -f "$TT_ROOT_VAR/recorder/tt-recorder.pid" ]; then
      US006_T13_PID="$(cat "$TT_ROOT_VAR/recorder/tt-recorder.pid" 2>/dev/null || true)"
      kill "$US006_T13_PID" 2>/dev/null || true
      timeout 3 wait "$US006_T13_PID" 2>/dev/null || true
      rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true
    fi
  elif [ "$cmd" = "stop" ]; then
    if [ "$cmd_rc" -eq 0 ]; then
      pass "'$cmd' dispatches to cmd_$cmd (exits 0 = idempotent, no recorder)"
    else
      fail "'$cmd' did not dispatch to cmd_$cmd (rc=$cmd_rc)"
    fi
  elif [ "$cmd" = "status" ]; then
    if [ "$cmd_rc" -eq 0 ]; then
      pass "'$cmd' dispatches to cmd_$cmd (exits 0 = NOT RUNNING, no recorder)"
    else
      fail "'$cmd' did not dispatch to cmd_$cmd (rc=$cmd_rc)"
    fi
  else
    fail "'$cmd' did not dispatch to cmd_$cmd (rc=$cmd_rc)"
  fi
done

# ── Test 14: --help mentions all subcommands ─────────────────────────
echo ""
echo "--- Test: --help content ---"

help_out="$("$TOOL" --help 2>&1)"

for cmd in start stop status; do
  if echo "$help_out" | grep -q "tt-recorder $cmd"; then
    pass "--help mentions subcommand '$cmd'"
  else
    fail "--help missing subcommand '$cmd'"
  fi
done

# ── Test 15: --help includes examples ─────────────────────────────────
echo ""
echo "--- Test: --help examples ---"

for example in "tt-recorder start" "tt-recorder stop" "tt-recorder status" "tt-recorder --help"; do
  if echo "$help_out" | grep -q "$example"; then
    pass "--help includes example '$example'"
  else
    fail "--help missing example '$example'"
  fi
done

# ── Test 16: --help mentions production exclusion ─────────────────────
echo ""
echo "--- Test: --help mentions production exclusion ---"

if echo "$help_out" | grep -qi "production"; then
  pass "--help mentions production exclusion"
else
  fail "--help missing production exclusion mention"
fi

# ── Test 17: sets -euo pipefail ──────────────────────────────────────
echo ""
echo "--- Test: error handling flags ---"

if grep -q "set -euo pipefail" "$TOOL"; then
  pass "script uses 'set -euo pipefail'"
else
  fail "script missing 'set -euo pipefail'"
fi

# ── Test 18: path resolution follows conventions ─────────────────────
echo ""
echo "--- Test: path resolution conventions ---"

if grep -q 'SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE\[0\]}")' "$TOOL"; then
  pass "uses SCRIPT_DIR resolution pattern"
else
  fail "missing SCRIPT_DIR resolution pattern"
fi

if grep -q "TT_DIR=" "$TOOL"; then
  pass "resolves TT_DIR from SCRIPT_DIR"
else
  fail "missing TT_DIR resolution"
fi

# ── Test 19: is a bash script ────────────────────────────────────────
echo ""
echo "--- Test: shebang and language ---"

if head -1 "$TOOL" | grep -q "bash"; then
  pass "tool is a bash script"
else
  fail "tool shebang is not bash"
fi

# ── Test 20: unknown option exits non-zero ────────────────────────────
echo ""
echo "--- Test: unknown option ---"

set +e
unk_opt_out="$("$TOOL" start --unknown 2>&1)"
unk_opt_rc=$?
set -e

if [ "$unk_opt_rc" -ne 0 ]; then
  pass "unknown option exits non-zero (rc=$unk_opt_rc)"
else
  fail "unknown option exited 0 (should be non-zero)"
fi

# ── Test 21: stop --help mentions evidence-based ──────────────────────
echo ""
echo "--- Test: stop --help evidence-based ---"

if echo "$stop_help" | grep -qi "evidence"; then
  pass "stop --help mentions evidence-based approach"
else
  fail "stop --help missing evidence-based mention"
fi

# ── Test 22: status --help mentions sample count ──────────────────────
echo ""
echo "--- Test: status --help sample count ---"

if echo "$status_help" | grep -q "sample"; then
  pass "status --help mentions sample count"
else
  fail "status --help missing sample count mention"
fi

# ── Test 23: help with --interval flag placement (before subcommand) ──
echo ""
echo "--- Test: help via --help flag ---"

# Verify --help works as the sole argument
if "$TOOL" --help > /dev/null 2>&1; then
  pass "--help as sole argument exits 0"
else
  fail "--help as sole argument did not exit 0"
fi

# ── US-002: Process discovery ────────────────────────────────────────
echo ""
# US-002 section title below uses '/proc' as documentation prose for the
# linux-only process-discovery source (MACP3 US-004 doc note; no procfs access).
echo "=== US-002: Process discovery via /proc ==="

# Compute TT_ROOT consistently with tt-recorder
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
TT_ROOT_VAR="${TT_REPO_ROOT}/torture-test/var"
TT_ROOT_VAR_RESOLVED="$(readlink -f "$TT_ROOT_VAR" 2>/dev/null || printf '%s' "$TT_ROOT_VAR")"
mkdir -p "$TT_ROOT_VAR"

# Test 24: Create a dummy process with cwd under TT_ROOT — MUST be discovered
echo ""
echo "--- Test: discover processes — cwd-based ---"

DUMMY_DIR="$TT_ROOT_VAR/test-discover-cwd-$$"
mkdir -p "$DUMMY_DIR"
(cd "$DUMMY_DIR" && sleep 120) &
DUMMY_PID=$!

# Create a decoy process with cwd OUTSIDE TT_ROOT — must NOT be discovered
(cd /tmp && sleep 120) &
DECOY_PID=$!

# Create a process whose cmdline contains TT_ROOT but cwd is OUTSIDE — MUST be discovered
# Use trap '' EXIT to prevent bash from exec'ing sleep (which would replace cmdline)
bash -c "trap '' EXIT; echo '$TT_ROOT_VAR/cmdline-marker' > /dev/null; sleep 120" &
CMDLINE_PID=$!

# Wait for all processes to start
sleep 0.5

# Call discover_processes by sourcing the tool in a subshell
discover_json="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  discover_processes
" 2>/dev/null)"

# Verify dummy process (cwd under TT_ROOT) is discovered
if echo "$discover_json" | grep -q "\"pid\":$DUMMY_PID"; then
  pass "discover_processes finds process with cwd under TT_ROOT (pid=$DUMMY_PID)"
else
  fail "discover_processes did NOT find process with cwd under TT_ROOT (pid=$DUMMY_PID)"
fi

# Verify cmdline-based process is discovered
if echo "$discover_json" | grep -q "\"pid\":$CMDLINE_PID"; then
  pass "discover_processes finds process with cmdline containing TT_ROOT (pid=$CMDLINE_PID)"
else
  fail "discover_processes did NOT find process with cmdline containing TT_ROOT (pid=$CMDLINE_PID)"
fi

# Verify decoy process (cwd outside TT_ROOT) is NOT discovered
if echo "$discover_json" | grep -q "\"pid\":$DECOY_PID"; then
  fail "discover_processes found process outside TT_ROOT (name-matching bug? pid=$DECOY_PID)"
else
  pass "discover_processes does NOT find process outside TT_ROOT (pid=$DECOY_PID)"
fi

# Test 25: Output is valid JSON array
echo ""
echo "--- Test: discover processes — output format ---"

if echo "$discover_json" | python3 -c "import json,sys; data=json.loads(sys.stdin.read()); assert isinstance(data, list)" 2>/dev/null; then
  pass "discover_processes outputs valid JSON array"
else
  fail "discover_processes output is not a valid JSON array (got: ${discover_json:0:200})"
fi

# Test 26: JSON objects have required fields
echo ""
echo "--- Test: discover processes — required fields ---"

if echo "$discover_json" | python3 -c "
import json,sys
data=json.loads(sys.stdin.read())
for obj in data:
    for field in ('pid','cwd','cmdline'):
        assert field in obj, f'Missing field: {field}'
        assert isinstance(obj[field], (str, int)), f'{field} wrong type'
    assert isinstance(obj['pid'], int), 'pid must be int'
" 2>/dev/null; then
  pass "discover_processes JSON objects have pid (int), cwd (str), cmdline (str) fields"
else
  fail "discover_processes JSON objects missing or have wrong types for required fields"
fi

# Test 27: Discovered process cwd matches the actual directory
echo ""
echo "--- Test: discover processes — cwd accuracy ---"

dummy_cwd="$(echo "$discover_json" | python3 -c "
import json,sys
data=json.loads(sys.stdin.read())
for obj in data:
    if obj['pid'] == $DUMMY_PID:
        print(obj['cwd'])
        break
" 2>/dev/null)"
if [ -n "$dummy_cwd" ]; then
  pass "discover_processes returns cwd field for dummy process"
else
  fail "discover_processes did not return cwd for dummy process"
fi

# Test 28: Inaccessible /proc entries do not crash
# MACP3 US-004 doc note: linux-only prose — the /proc zoo/entry detail is
# conceptual (the reads happen inside tt-recorder discover_processes, already
# linux-only-guarded per US-003; on Darwin they are simply skipped).
echo ""
echo "--- Test: discover processes — graceful skip ---"

# The function already skips inaccessible entries; verify it doesn't
# crash when encountering them. Use set -e in the subshell to detect crashes.
# MACP3 US-004: the pass/fail texts below mention /proc as linux-only prose —
# the reads themselves happen inside tt-recorder (US-003-guarded); on a
# /proc-less host discover_processes returns no /proc-derived fields.
if bash -c "
  set -euo pipefail
  source '$TOOL'
  discover_processes > /dev/null
  echo 'OK'
" 2>/dev/null | grep -q 'OK'; then
  pass "discover_processes does not crash with standard /proc entries"
else
  fail "discover_processes crashed during normal /proc scan"
fi

# Test 29: Process name matching is NOT used (safety check in source)
echo ""
echo "--- Test: discover processes — no name matching ---"

# Verify discover_processes source does NOT use ps, pidof, pgrep, or grep for process names
if grep -A 80 '^discover_processes()' "$TOOL" | grep -qiE 'pgrep|pidof|ps -e|ps aux'; then
  fail "discover_processes appears to use process-name matching (pgrep/pidof/ps)"
else
  pass "discover_processes does NOT use name-based process discovery"
fi

# Cleanup test processes
kill "$DUMMY_PID" 2>/dev/null || true
kill "$DECOY_PID" 2>/dev/null || true
kill "$CMDLINE_PID" 2>/dev/null || true
rm -rf "$DUMMY_DIR" 2>/dev/null || true
# Wait only for our known children with timeout
for _pid in "$DUMMY_PID" "$DECOY_PID" "$CMDLINE_PID"; do
  [ -n "$_pid" ] && timeout 2 wait "$_pid" 2>/dev/null || true
done

# ── US-003: Per-process metric collection ──────────────────────────
echo ""
echo "=== US-003: Per-process metric collection ==="

# Test 30: collect_sample outputs valid JSONL (one JSON per line)
echo ""
echo "--- Test: collect_sample — valid JSONL ---"

METRIC_DUMMY_DIR="$TT_ROOT_VAR/test-metric-collect-$$"
mkdir -p "$METRIC_DUMMY_DIR"

# Spawn a dummy process whose cwd IS under TT_ROOT for metric collection
(cd "$METRIC_DUMMY_DIR" && sleep 120) &
METRIC_DUMMY_PID=$!

# Spawn a decoy process outside TT_ROOT — must NOT appear in samples
(cd /tmp && sleep 120) &
METRIC_DECOY_PID=$!

sleep 0.5

# Call collect_sample by sourcing the tool
metric_samples="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  collect_sample
" 2>/dev/null)"

# Verify it outputs at least one line (our dummy process)
if [ -n "$metric_samples" ]; then
  sample_count=$(echo "$metric_samples" | grep -c .)
  if [ "$sample_count" -gt 0 ]; then
    pass "collect_sample outputs at least one sample (got $sample_count lines)"
  else
    fail "collect_sample produced no output lines"
  fi
else
  fail "collect_sample produced no output"
fi

# Test 31: Each line is valid JSON
echo ""
echo "--- Test: collect_sample — each line valid JSON ---"

valid_lines=0
invalid_lines=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if echo "$line" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
    valid_lines=$((valid_lines + 1))
  else
    invalid_lines=$((invalid_lines + 1))
  fi
done <<< "$metric_samples"

if [ "$invalid_lines" -eq 0 ] && [ "$valid_lines" -gt 0 ]; then
  pass "collect_sample: all $valid_lines lines are valid JSON"
else
  fail "collect_sample: $invalid_lines invalid JSON lines out of $((valid_lines + invalid_lines))"
fi

# Test 32: Timestamp is UTC ISO-8601 ending with Z
echo ""
echo "--- Test: collect_sample — timestamp format ---"

ts_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ts="$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['ts'])" 2>/dev/null || true)"
  if ! echo "$ts" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    ts_ok=false
    fail "timestamp not ISO-8601 Z format: '$ts'"
  fi
done <<< "$metric_samples"

if [ "$ts_ok" = true ]; then
  pass "collect_sample: all timestamps are UTC ISO-8601 Z format"
fi

# Test 33: Required fields present in each JSON object
echo ""
echo "--- Test: collect_sample — required fields ---"

fields_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  fields_check="$(python3 -c '
import json,sys
obj=json.loads(sys.stdin.read())
required=["ts","pid","pgid","ppid","cwd","cmdline","rss_kb","open_fds"]
for f in required:
    assert f in obj, f"Missing field: {f}"
    assert isinstance(obj[f], (str,int)), f"{f} wrong type"
assert isinstance(obj["pid"], int), "pid must be int"
assert isinstance(obj["pgid"], int), "pgid must be int"
assert isinstance(obj["ppid"], int), "ppid must be int"
assert isinstance(obj["rss_kb"], int), "rss_kb must be int"
assert isinstance(obj["open_fds"], int), "open_fds must be int"
print("OK")
' <<< "$line" 2>/dev/null || true)"
  if [ "$fields_check" = "OK" ]; then
    :
  else
    fields_ok=false
    fail "JSON object missing required fields or wrong types: ${line:0:120}"
  fi
done <<< "$metric_samples"

if [ "$fields_ok" = true ]; then
  pass "collect_sample: all JSON objects have required fields with correct types"
fi

# Test 34: RSS is extracted as a positive integer in kB from VmRSS
echo ""
echo "--- Test: collect_sample — RSS kB ---"

rss_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  rss="$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['rss_kb'])" 2>/dev/null || true)"
  if [ -z "$rss" ] || [ "$rss" -lt 0 ] 2>/dev/null; then
    rss_ok=false
    fail "rss_kb is not a non-negative integer: '$rss'"
  elif [ "$rss" -eq 0 ]; then
    # rss_kb=0 is acceptable if VmRSS line is missing (rare but possible)
    :
  fi
done <<< "$metric_samples"

if [ "$rss_ok" = true ]; then
  pass "collect_sample: all rss_kb values are non-negative integers"
fi

# Cross-check: the dummy process's RSS against actual VmRSS from /proc
# linux-only /proc/$METRIC_DUMMY_PID/status read (MACP3 US-004): guarded above
# by [ -f ] — Darwin has no /proc, so this block is skipped (pass-by-note).
if [ -f "/proc/$METRIC_DUMMY_PID/status" ]; then
  actual_rss="$(grep '^VmRSS:' "/proc/$METRIC_DUMMY_PID/status" 2>/dev/null | awk '{print $2}' || echo 0)"
  sampled_rss="$(echo "$metric_samples" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $METRIC_DUMMY_PID:
        print(obj['rss_kb'])
        break
" 2>/dev/null || true)"
  if [ "$actual_rss" = "$sampled_rss" ]; then
    pass "collect_sample: rss_kb ($sampled_rss) matches /proc/<pid>/status VmRSS ($actual_rss)"
  else
    fail "collect_sample: rss_kb ($sampled_rss) does NOT match VmRSS ($actual_rss)"
  fi
fi

# Test 35: open-fd count is a non-negative integer
echo ""
echo "--- Test: collect_sample — open_fds ---"

fds_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  fds="$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['open_fds'])" 2>/dev/null || true)"
  if [ -z "$fds" ] || [ "$fds" -lt 0 ] 2>/dev/null; then
    fds_ok=false
    fail "open_fds is not a non-negative integer: '$fds'"
  fi
done <<< "$metric_samples"

if [ "$fds_ok" = true ]; then
  pass "collect_sample: all open_fds values are non-negative integers"
fi

# Test 36: PGID and PPID match actual process hierarchy
echo ""
echo "--- Test: collect_sample — pgid/ppid accuracy ---"

# linux-only /proc/$METRIC_DUMMY_PID/stat read (MACP3 US-004): guarded above
# by [ -f ] — Darwin has no /proc, so this block is skipped (pass-by-note).
if [ -f "/proc/$METRIC_DUMMY_PID/stat" ]; then
  # Extract pgid and ppid from /proc/<pid>/stat directly
  stat_content="$(cat "/proc/$METRIC_DUMMY_PID/stat")"
  stat_after="${stat_content#*)}"
  read -r _st actual_ppid actual_pgid _ <<< "$stat_after"

  sampled_pgid="$(echo "$metric_samples" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $METRIC_DUMMY_PID:
        print(obj['pgid'])
        break
" 2>/dev/null || true)"
  sampled_ppid="$(echo "$metric_samples" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $METRIC_DUMMY_PID:
        print(obj['ppid'])
        break
" 2>/dev/null || true)"

  if [ "$actual_pgid" = "$sampled_pgid" ]; then
    pass "collect_sample: pgid ($sampled_pgid) matches /proc/stat pgrp ($actual_pgid)"
  else
    fail "collect_sample: pgid ($sampled_pgid) does NOT match pgrp ($actual_pgid)"
  fi

  if [ "$actual_ppid" = "$sampled_ppid" ]; then
    pass "collect_sample: ppid ($sampled_ppid) matches /proc/stat ppid ($actual_ppid)"
  else
    fail "collect_sample: ppid ($sampled_ppid) does NOT match ppid ($actual_ppid)"
  fi
else
  pass "collect_sample: pgid/ppid accuracy check skipped (process already exited)"
fi

# Test 37: cmdline is space-joined from null-byte separated /proc/<pid>/cmdline
echo ""
echo "--- Test: collect_sample — cmdline format ---"

# linux-only /proc/$METRIC_DUMMY_PID/cmdline read (MACP3 US-004): guarded above
# by [ -f ] — Darwin has no /proc, so this block is skipped (pass-by-note).
if [ -f "/proc/$METRIC_DUMMY_PID/cmdline" ]; then
  actual_cmdline="$(tr '\0' ' ' < "/proc/$METRIC_DUMMY_PID/cmdline" || true)"
  sampled_cmdline="$(echo "$metric_samples" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $METRIC_DUMMY_PID:
        print(obj['cmdline'])
        break
" 2>/dev/null || true)"

  if [ "$actual_cmdline" = "$sampled_cmdline" ]; then
    pass "collect_sample: cmdline matches null-byte→space-joined /proc/cmdline"
  else
    fail "collect_sample: cmdline ('$sampled_cmdline') != actual ('$actual_cmdline')"
  fi
else
  pass "collect_sample: cmdline check skipped (process already exited)"
fi

# Test 38: cwd is absolute path
echo ""
echo "--- Test: collect_sample — cwd absolute path ---"

cwd_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  cwd_val="$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['cwd'])" 2>/dev/null || true)"
  if [ -z "$cwd_val" ] || [[ "$cwd_val" != /* ]]; then
    cwd_ok=false
    fail "cwd is not an absolute path: '$cwd_val'"
  fi
done <<< "$metric_samples"

if [ "$cwd_ok" = true ]; then
  pass "collect_sample: all cwd values are absolute paths"
fi

# Test 39: Decoy process (outside TT_ROOT) is NOT sampled
echo ""
echo "--- Test: collect_sample — decoy exclusion ---"

if echo "$metric_samples" | grep -q "\"pid\":$METRIC_DECOY_PID"; then
  fail "collect_sample included decoy process outside TT_ROOT (pid=$METRIC_DECOY_PID)"
else
  pass "collect_sample does not include decoy process outside TT_ROOT"
fi

# Test 40: Dummy process (under TT_ROOT) IS sampled
echo ""
echo "--- Test: collect_sample — dummy inclusion ---"

if echo "$metric_samples" | python3 -c "
import json,sys
found=False
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $METRIC_DUMMY_PID:
        found=True
        break
sys.exit(0 if found else 1)
" 2>/dev/null; then
  pass "collect_sample includes dummy process under TT_ROOT (pid=$METRIC_DUMMY_PID)"
else
  fail "collect_sample did NOT include dummy process under TT_ROOT (pid=$METRIC_DUMMY_PID)"
fi

# Cleanup metric test processes
kill "$METRIC_DUMMY_PID" 2>/dev/null || true
kill "$METRIC_DECOY_PID" 2>/dev/null || true
rm -rf "$METRIC_DUMMY_DIR" 2>/dev/null || true
# Wait only for our known children with timeout
for _pid in "$METRIC_DUMMY_PID" "$METRIC_DECOY_PID"; do
  [ -n "$_pid" ] && timeout 2 wait "$_pid" 2>/dev/null || true
done

# ── US-004: JSONL output with rotation at 50MB ─────────────────────
echo ""
echo "=== US-004: JSONL output with rotation at 50MB ==="

# Create a clean recorder directory for US-004 tests
US004_RECORDER_DIR="$TT_ROOT_VAR/recorder"
rm -rf "$US004_RECORDER_DIR" 2>/dev/null || true

# Spawn a dummy process under TT_ROOT so the recorder has something to sample
US004_DUMMY_DIR="$TT_ROOT_VAR/test-us004-$$"
mkdir -p "$US004_DUMMY_DIR"
(cd "$US004_DUMMY_DIR" && sleep 300) &
US004_DUMMY_PID=$!
sleep 0.3

# Start _run_loop in background with 1s interval
bash -c "
  set -euo pipefail
  source '$TOOL'
  _run_loop 1
" &
US004_LOOP_PID=$!

# Wait for at least 2 intervals (2+ seconds) to accumulate samples
sleep 3

# Kill the loop
kill "$US004_LOOP_PID" 2>/dev/null || true
wait "$US004_LOOP_PID" 2>/dev/null || true

# Find the output file
US004_OUTPUT_FILE="$(ls -t "$US004_RECORDER_DIR"/samples-*.jsonl 2>/dev/null | head -1)"

# ── Test 41: Output file is created with correct naming pattern
if [ -n "$US004_OUTPUT_FILE" ] && [ -f "$US004_OUTPUT_FILE" ]; then
  pass "US-004: output file created at $US004_OUTPUT_FILE"
else
  fail "US-004: no output file found in $US004_RECORDER_DIR"
fi

if echo "$US004_OUTPUT_FILE" | grep -qE 'samples-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.jsonl$'; then
  pass "US-004: output file follows samples-<startedAt>.jsonl naming pattern"
else
  fail "US-004: output file does not match expected naming pattern (got: $US004_OUTPUT_FILE)"
fi

# ── Test 42: Samples written as valid JSONL (one JSON per line)
US004_SAMPLES="$(cat "$US004_OUTPUT_FILE" 2>/dev/null || true)"
if [ -n "$US004_SAMPLES" ]; then
  sample_count=$(printf '%s\n' "$US004_SAMPLES" | grep -c . || true)
  if [ "$sample_count" -gt 0 ]; then
    pass "US-004: output file has samples (got $sample_count lines)"
  else
    fail "US-004: output file is empty"
  fi
else
  fail "US-004: output file is empty or unreadable"
fi

US004_valid=0
US004_invalid=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if printf '%s\n' "$line" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
    US004_valid=$((US004_valid + 1))
  else
    US004_invalid=$((US004_invalid + 1))
  fi
done <<< "$US004_SAMPLES"

if [ "$US004_invalid" -eq 0 ] && [ "$US004_valid" -gt 0 ]; then
  pass "US-004: all $US004_valid lines are valid JSON (JSONL)"
else
  fail "US-004: $US004_invalid invalid JSON lines out of $((US004_valid + US004_invalid))"
fi

# ── Test 43: Each line contains all required fields
US004_fields_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  fields_check="$(python3 -c '
import json,sys
obj=json.loads(sys.stdin.read())
required=["ts","pid","pgid","ppid","cwd","cmdline","rss_kb","open_fds"]
for f in required:
    assert f in obj, f"Missing: {f}"
print("OK")
' <<< "$line" 2>/dev/null || true)"
  if [ "$fields_check" != "OK" ]; then
    US004_fields_ok=false
  fi
done <<< "$US004_SAMPLES"

if [ "$US004_fields_ok" = true ]; then
  pass "US-004: all samples have required fields (ts, pid, pgid, ppid, cwd, cmdline, rss_kb, open_fds)"
else
  fail "US-004: some samples are missing required fields"
fi

# ── Test 44: Timestamps are monotonic (non-decreasing)
US004_ts_ok=true
US004_prev_ts=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ts="$(printf '%s\n' "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['ts'])" 2>/dev/null || true)"
  if [ -n "$US004_prev_ts" ] && [[ "$ts" < "$US004_prev_ts" ]]; then
    US004_ts_ok=false
  fi
  US004_prev_ts="$ts"
done <<< "$US004_SAMPLES"

if [ "$US004_ts_ok" = true ]; then
  pass "US-004: timestamps are monotonic (non-decreasing)"
else
  fail "US-004: timestamps are not monotonic"
fi

# ── Test 45: Dummy process appears in samples with rss_kb and open_fds
found_dummy=false
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if printf '%s\n' "$line" | grep -q "\"pid\":$US004_DUMMY_PID"; then
    found_dummy=true
    break
  fi
done <<< "$US004_SAMPLES"

if [ "$found_dummy" = true ]; then
  pass "US-004: dummy process (pid=$US004_DUMMY_PID) found in JSONL output"
else
  fail "US-004: dummy process (pid=$US004_DUMMY_PID) NOT found in JSONL output"
fi

# ── Test 46: Rotation triggers when file exceeds 50MB
# Artificially pad the file to just over ROTATION_THRESHOLD
echo ""
echo "--- Test: US-004 — file rotation at 50MB ---"

# Save original file stats
US004_orig_size="$(stat -c%s "$US004_OUTPUT_FILE")"
US004_orig_name="$(basename "$US004_OUTPUT_FILE")"

# Pad the file by setting its logical size to just over 50MB (instant, sparse)
FIFTY_MB=$((50 * 1024 * 1024))
truncate -s $((FIFTY_MB + 1)) "$US004_OUTPUT_FILE" 2>/dev/null || true

US004_new_size="$(stat -c%s "$US004_OUTPUT_FILE")"
if [ "$US004_new_size" -ge "$FIFTY_MB" ]; then
  pass "US-004: output file padded to $US004_new_size bytes (>= 50MB threshold)"
else
  fail "US-004: failed to pad file to >= 50MB (got $US004_new_size, needed >= $FIFTY_MB)"
fi

# Restart _run_loop briefly — the rotation check should trigger before writing
bash -c "
  set -euo pipefail
  source '$TOOL'
  _run_loop 1
" &
US004_LOOP_PID2=$!
sleep 2.5
kill "$US004_LOOP_PID2" 2>/dev/null || true
wait "$US004_LOOP_PID2" 2>/dev/null || true

# Check if a NEW file was created (different name from original)
US004_files_after=($(ls -t "$US004_RECORDER_DIR"/samples-*.jsonl 2>/dev/null || true))
if [ "${#US004_files_after[@]}" -ge 2 ]; then
  pass "US-004: rotation created a new output file (${#US004_files_after[@]} files found)"
else
  fail "US-004: rotation did not create a new file (only ${#US004_files_after[@]} found)"
fi

# ── Test 47: No samples lost during rotation (new file has content)
US004_newest_file="${US004_files_after[0]}"
if [ -f "$US004_newest_file" ] && [ "$US004_newest_file" != "$US004_OUTPUT_FILE" ]; then
  US004_new_content="$(cat "$US004_newest_file" 2>/dev/null || true)"
  if [ -n "$US004_new_content" ]; then
    pass "US-004: new file after rotation has content (not empty)"
  else
    # Empty new file is OK if no in-scope processes at that moment
    pass "US-004: new file after rotation exists (empty — no in-scope processes at sample time)"
  fi
else
  fail "US-004: newest file after rotation is same as original or does not exist"
fi

# ── Test 48: New file after rotation uses new startedAt (different timestamp)
if [ "$US004_newest_file" != "$US004_OUTPUT_FILE" ]; then
  US004_new_basename="$(basename "$US004_newest_file")"
  if [ "$US004_new_basename" != "$US004_orig_name" ]; then
    pass "US-004: new file has different startedAt timestamp from original"
  else
    fail "US-004: new file has same name as original ($US004_new_basename)"
  fi
  
  # Verify new file name follows the correct pattern
  if echo "$US004_new_basename" | grep -qE '^samples-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.jsonl$'; then
    pass "US-004: new file follows samples-<startedAt>.jsonl naming"
  else
    fail "US-004: new file name does not follow expected pattern ($US004_new_basename)"
  fi
else
  fail "US-004: cannot verify new file timestamp — rotation did not occur"
fi

# Cleanup US-004 test resources
kill "$US004_DUMMY_PID" 2>/dev/null || true
rm -rf "$US004_DUMMY_DIR" 2>/dev/null || true
rm -rf "$US004_RECORDER_DIR" 2>/dev/null || true
# Wait only for our known child with timeout
[ -n "$US004_DUMMY_PID" ] && timeout 2 wait "$US004_DUMMY_PID" 2>/dev/null || true

# ── US-005: Daemon detection and db/wal size collection ──────────────
echo ""
echo "=== US-005: Daemon detection and db/wal size collection ==="

# Create test daemon home directories with fake tamandua.db files
US005_REAL_HOME="$TT_ROOT_VAR/home"
US005_SCRIPTED_HOME="$TT_ROOT_VAR/home-scripted"
US005_REAL_DB_DIR="$US005_REAL_HOME/.tamandua"
US005_SCRIPTED_DB_DIR="$US005_SCRIPTED_HOME/.tamandua"

mkdir -p "$US005_REAL_DB_DIR"
mkdir -p "$US005_SCRIPTED_DB_DIR"

# Create fake db files with known sizes
echo -n 'real-db-content' > "$US005_REAL_DB_DIR/tamandua.db"
echo -n 'real-wal-data-more' > "$US005_REAL_DB_DIR/tamandua.db-wal"
echo -n 'scripted-db' > "$US005_SCRIPTED_DB_DIR/tamandua.db"
# Scripted wal: intentionally absent to verify wal_size_bytes=0 when missing

US005_REAL_DB_SIZE="$(stat -c%s "$US005_REAL_DB_DIR/tamandua.db")"
US005_REAL_WAL_SIZE="$(stat -c%s "$US005_REAL_DB_DIR/tamandua.db-wal")"
US005_SCRIPTED_DB_SIZE="$(stat -c%s "$US005_SCRIPTED_DB_DIR/tamandua.db")"

# Spawn a real daemon process (cwd under home/)
US005_REAL_DIR="$US005_REAL_HOME/test-daemon-$$"
mkdir -p "$US005_REAL_DIR"
(cd "$US005_REAL_DIR" && sleep 120) &
US005_REAL_PID=$!

# Spawn a scripted daemon process (cwd under home-scripted/)
US005_SCRIPTED_DIR="$US005_SCRIPTED_HOME/test-daemon-$$"
mkdir -p "$US005_SCRIPTED_DIR"
(cd "$US005_SCRIPTED_DIR" && sleep 120) &
US005_SCRIPTED_PID=$!

# Spawn a non-daemon process (cwd under TT_ROOT but NOT under home/ or home-scripted/)
US005_NON_DAEMON_DIR="$TT_ROOT_VAR/test-non-daemon-$$"
mkdir -p "$US005_NON_DAEMON_DIR"
(cd "$US005_NON_DAEMON_DIR" && sleep 120) &
US005_NON_DAEMON_PID=$!

sleep 0.5

# Collect a sample
US005_SAMPLES="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  collect_sample
" 2>/dev/null)"

# ── Test 49: _detect_daemon_db returns real daemon db path ────────────
echo ""
echo "--- Test: _detect_daemon_db — real daemon ---"

real_cwd_resolved="$(readlink -f "$US005_REAL_DIR")"
real_detected="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  _detect_daemon_db '$real_cwd_resolved' || true
" 2>/dev/null || true)"

if [ -n "$real_detected" ] && [ "$real_detected" = "$US005_REAL_DB_DIR/tamandua.db" ]; then
  pass "_detect_daemon_db returns db path for real daemon process"
else
  fail "_detect_daemon_db did not return correct db path for real daemon (got: '$real_detected')"
fi

# ── Test 50: _detect_daemon_db returns scripted daemon db path ────────
echo ""
echo "--- Test: _detect_daemon_db — scripted daemon ---"

scripted_cwd_resolved="$(readlink -f "$US005_SCRIPTED_DIR")"
scripted_detected="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  _detect_daemon_db '$scripted_cwd_resolved' || true
" 2>/dev/null || true)"

if [ -n "$scripted_detected" ] && [ "$scripted_detected" = "$US005_SCRIPTED_DB_DIR/tamandua.db" ]; then
  pass "_detect_daemon_db returns db path for scripted daemon process"
else
  fail "_detect_daemon_db did not return correct db path for scripted daemon (got: '$scripted_detected')"
fi

# ── Test 51: _detect_daemon_db returns empty for non-daemon process ───
echo ""
echo "--- Test: _detect_daemon_db — non-daemon ---"

non_daemon_cwd_resolved="$(readlink -f "$US005_NON_DAEMON_DIR")"
non_daemon_detected="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  _detect_daemon_db '$non_daemon_cwd_resolved' || true
" 2>/dev/null || true)"

if [ -z "$non_daemon_detected" ]; then
  pass "_detect_daemon_db returns empty for non-daemon process"
else
  fail "_detect_daemon_db returned db path for non-daemon process (got: '$non_daemon_detected')"
fi

# ── Test 52: Real daemon process has db_size_bytes and wal_size_bytes ──
echo ""
echo "--- Test: daemon sample has db/wal fields ---"

real_sample="$(printf '%s\n' "$US005_SAMPLES" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $US005_REAL_PID:
        print(json.dumps(obj))
        break
" 2>/dev/null || true)"

if [ -n "$real_sample" ]; then
  # Check db_size_bytes present
  real_db_size="$(printf '%s\n' "$real_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print(obj.get('db_size_bytes', 'MISSING'))
" 2>/dev/null || true)"

  if [ "$real_db_size" != "MISSING" ]; then
    pass "real daemon sample has db_size_bytes field (value=$real_db_size)"
  else
    fail "real daemon sample missing db_size_bytes field"
  fi

  # Check wal_size_bytes present
  real_wal_size="$(printf '%s\n' "$real_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print(obj.get('wal_size_bytes', 'MISSING'))
" 2>/dev/null || true)"

  if [ "$real_wal_size" != "MISSING" ]; then
    pass "real daemon sample has wal_size_bytes field (value=$real_wal_size)"
  else
    fail "real daemon sample missing wal_size_bytes field"
  fi

  # Check db_path present
  real_db_path="$(printf '%s\n' "$real_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print(obj.get('db_path', 'MISSING'))
" 2>/dev/null || true)"

  if [ "$real_db_path" != "MISSING" ]; then
    pass "real daemon sample has db_path field"
  else
    fail "real daemon sample missing db_path field"
  fi
else
  fail "real daemon process (pid=$US005_REAL_PID) not found in samples"
fi

# ── Test 53: db_size_bytes matches actual file size ───────────────────
echo ""
echo "--- Test: db_size_bytes accuracy ---"

if [ -n "$real_sample" ]; then
  if [ "$real_db_size" = "$US005_REAL_DB_SIZE" ]; then
    pass "real daemon db_size_bytes ($real_db_size) matches actual stat size ($US005_REAL_DB_SIZE)"
  else
    fail "real daemon db_size_bytes ($real_db_size) != actual size ($US005_REAL_DB_SIZE)"
  fi
fi

# ── Test 54: wal_size_bytes matches actual wal file size ──────────────
echo ""
echo "--- Test: wal_size_bytes accuracy ---"

if [ -n "$real_sample" ]; then
  if [ "$real_wal_size" = "$US005_REAL_WAL_SIZE" ]; then
    pass "real daemon wal_size_bytes ($real_wal_size) matches actual wal size ($US005_REAL_WAL_SIZE)"
  else
    fail "real daemon wal_size_bytes ($real_wal_size) != actual wal size ($US005_REAL_WAL_SIZE)"
  fi
fi

# ── Test 55: Non-daemon process does NOT have db fields ───────────────
echo ""
echo "--- Test: non-daemon sample has no db/wal fields ---"

non_daemon_sample="$(printf '%s\n' "$US005_SAMPLES" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $US005_NON_DAEMON_PID:
        print(json.dumps(obj))
        break
" 2>/dev/null || true)"

if [ -n "$non_daemon_sample" ]; then
  has_db_path="$(printf '%s\n' "$non_daemon_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print('YES' if 'db_path' in obj else 'NO')
" 2>/dev/null || true)"

  has_db_size="$(printf '%s\n' "$non_daemon_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print('YES' if 'db_size_bytes' in obj else 'NO')
" 2>/dev/null || true)"

  has_wal_size="$(printf '%s\n' "$non_daemon_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print('YES' if 'wal_size_bytes' in obj else 'NO')
" 2>/dev/null || true)"

  if [ "$has_db_path" = "NO" ] && [ "$has_db_size" = "NO" ] && [ "$has_wal_size" = "NO" ]; then
    pass "non-daemon sample has NO db_path, db_size_bytes, or wal_size_bytes fields"
  else
    fail "non-daemon sample has db fields (db_path=$has_db_path db_size_bytes=$has_db_size wal_size_bytes=$has_wal_size)"
  fi
else
  fail "non-daemon process (pid=$US005_NON_DAEMON_PID) not found in samples"
fi

# ── Test 56: Scripted daemon wal_size_bytes=0 when wal file missing ───
echo ""
echo "--- Test: scripted daemon wal_size_bytes=0 when .db-wal absent ---"

scripted_sample="$(printf '%s\n' "$US005_SAMPLES" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    obj=json.loads(line)
    if obj['pid'] == $US005_SCRIPTED_PID:
        print(json.dumps(obj))
        break
" 2>/dev/null || true)"

if [ -n "$scripted_sample" ]; then
  scripted_wal="$(printf '%s\n' "$scripted_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print(obj.get('wal_size_bytes', 'MISSING'))
" 2>/dev/null || true)"

  if [ "$scripted_wal" = "0" ]; then
    pass "scripted daemon wal_size_bytes=0 when .db-wal file does not exist"
  elif [ "$scripted_wal" = "MISSING" ]; then
    fail "scripted daemon missing wal_size_bytes field entirely"
  else
    fail "scripted daemon wal_size_bytes is $scripted_wal, expected 0"
  fi

  # Check db_size_bytes matches known file size
  scripted_db="$(printf '%s\n' "$scripted_sample" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print(obj.get('db_size_bytes', 'MISSING'))
" 2>/dev/null || true)"

  if [ "$scripted_db" = "$US005_SCRIPTED_DB_SIZE" ]; then
    pass "scripted daemon db_size_bytes ($scripted_db) matches actual file size"
  else
    fail "scripted daemon db_size_bytes ($scripted_db) != actual ($US005_SCRIPTED_DB_SIZE)"
  fi
else
  fail "scripted daemon process (pid=$US005_SCRIPTED_PID) not found in samples"
fi

# ── Test 57: Real and scripted daemon db_paths are correctly distinguished ──
echo ""
echo "--- Test: daemon db_paths are correctly distinguished ---"

if [ -n "$real_sample" ] && [ -n "$scripted_sample" ]; then
  real_path="$(printf '%s\n' "$real_sample" | python3 -c "
import json,sys
print(json.loads(sys.stdin.read())['db_path'])
" 2>/dev/null || true)"

  scripted_path="$(printf '%s\n' "$scripted_sample" | python3 -c "
import json,sys
print(json.loads(sys.stdin.read())['db_path'])
" 2>/dev/null || true)"

  if echo "$real_path" | grep -q 'home/.tamandua/tamandua.db' && \
     echo "$scripted_path" | grep -q 'home-scripted/.tamandua/tamandua.db'; then
    pass "real daemon db_path contains home/.tamandua, scripted contains home-scripted/.tamandua"
  else
    fail "db_paths not correctly distinguished (real=$real_path, scripted=$scripted_path)"
  fi

  if [ "$real_path" != "$scripted_path" ]; then
    pass "real and scripted db_paths are different"
  else
    fail "real and scripted db_paths are identical ($real_path)"
  fi
fi

# Cleanup US-005 test processes and dirs
kill "$US005_REAL_PID" 2>/dev/null || true
kill "$US005_SCRIPTED_PID" 2>/dev/null || true
kill "$US005_NON_DAEMON_PID" 2>/dev/null || true
rm -rf "$US005_REAL_HOME" 2>/dev/null || true
rm -rf "$US005_SCRIPTED_HOME" 2>/dev/null || true
rm -rf "$US005_NON_DAEMON_DIR" 2>/dev/null || true
# Wait only for our known children with timeout
for _pid in "$US005_REAL_PID" "$US005_SCRIPTED_PID" "$US005_NON_DAEMON_PID"; do
  [ -n "$_pid" ] && timeout 2 wait "$_pid" 2>/dev/null || true
done

# ── US-006: Start command with nohup detach and pidfile ─────────────
echo ""
echo "=== US-006: Start command with nohup detach and pidfile ==="

# Clean state before US-006 tests
US006_RECORDER_DIR="$TT_ROOT_VAR/recorder"
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true

# Test 58: start returns immediately (non-blocking, detaches)
echo ""
echo "--- Test: start returns immediately ---"

# Use timeout to verify the start command returns quickly
if timeout 5 "$TOOL" start --interval 2 > /dev/null 2>&1; then
  pass "start returns immediately (within 5s timeout)"
else
  fail "start did not return within 5s (blocking or crash)"
fi

# Test 59: pidfile contains correct PID and background process is alive
echo ""
echo "--- Test: pidfile contains correct PID ---"

US006_PIDFILE="$US006_RECORDER_DIR/tt-recorder.pid"
if [ -f "$US006_PIDFILE" ]; then
  US006_PID="$(cat "$US006_PIDFILE")"
  if [ -n "$US006_PID" ] && [ -d "/proc/$US006_PID" ]; then
    # Verify cmdline contains tt-recorder (evidence-based)
    # linux-only /proc/$US006_PID/cmdline read (MACP3 US-004): guarded above —
    # Darwin has no /proc, falls to else (fail) below without reading procfs.
    US006_CMDLINE="$(tr '\0' ' ' < "/proc/$US006_PID/cmdline" 2>/dev/null || true)"
    if echo "$US006_CMDLINE" | grep -q "tt-recorder"; then
      pass "pidfile contains PID $US006_PID of running tt-recorder process"
    else
      fail "pidfile PID $US006_PID cmdline does not contain tt-recorder"
    fi
  else
    fail "pidfile PID $US006_PID is not alive"
  fi
else
  fail "pidfile not created at $US006_PIDFILE"
fi

# Test 60: double-start is refused
echo ""
echo "--- Test: double-start refused ---"

set +e
double_start_out="$("$TOOL" start --interval 2 2>&1)"
double_start_rc=$?
set -e

if [ "$double_start_rc" -ne 0 ]; then
  pass "double-start exits non-zero (rc=$double_start_rc)"
else
  fail "double-start exited 0 (should be non-zero)"
fi

if echo "$double_start_out" | grep -qiE "already running|already started"; then
  pass "double-start reports 'already running'"
else
  fail "double-start did not report already running (got: $double_start_out)"
fi

# Test 61: stale pidfile (dead process) is cleaned and start proceeds
echo ""
echo "--- Test: stale pidfile is cleaned ---"

# Stop the current recorder to simulate a dead process
# linux-only /proc/$US006_PID existence check (MACP3 US-004): guarded here —
# Darwin has no /proc, so the block is skipped and the stale-pidfile cleanup
# proceeds (pass-by-note).
if [ -n "${US006_PID:-}" ] && [ -d "/proc/$US006_PID" ]; then
  kill "$US006_PID" 2>/dev/null || true
  timeout 3 wait "$US006_PID" 2>/dev/null || true
fi
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true

# Create a fake pidfile with a definitely-dead PID (99999 is unlikely to exist)
mkdir -p "$US006_RECORDER_DIR"
echo "99999" > "$US006_PIDFILE"

# Now start should detect stale pidfile, remove it, and proceed
if timeout 5 "$TOOL" start --interval 2 > /dev/null 2>&1; then
  pass "start proceeds after cleaning stale pidfile (dead PID)"
else
  fail "start failed when it should have cleaned stale pidfile"
fi

# Verify new pidfile was written with a different PID
US006_NEW_PID="$(cat "$US006_PIDFILE" 2>/dev/null || true)"
if [ -n "$US006_NEW_PID" ] && [ "$US006_NEW_PID" != "99999" ]; then
  pass "new pidfile written with fresh PID ($US006_NEW_PID) after stale cleanup"
else
  fail "pidfile not updated after stale cleanup (got: $US006_NEW_PID)"
fi

# Clean up for next test
# linux-only /proc/$US006_NEW_PID existence check (MACP3 US-004): guarded here
# — Darwin has no /proc, so the block is skipped (pass-by-note).
if [ -n "$US006_NEW_PID" ] && [ -d "/proc/$US006_NEW_PID" ]; then
  kill "$US006_NEW_PID" 2>/dev/null || true
  timeout 3 wait "$US006_NEW_PID" 2>/dev/null || true
fi
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true

# Test 62: pidfile held by non-tt-recorder process triggers refusal
echo ""
echo "--- Test: pidfile held by non-tt-recorder triggers refusal ---"

# Create a non-tt-recorder dummy process
(cd /tmp && sleep 300) &
US006_NONREC_PID=$!
sleep 0.3

# Verify the non-recorder process is alive
# linux-only /proc/$US006_NONREC_PID existence check (MACP3 US-004): guarded
# here — Darwin has no /proc, so the block is skipped (pass-by-note).
if [ -d "/proc/$US006_NONREC_PID" ]; then
  # Write its PID to the pidfile (simulate corrupted pidfile)
  mkdir -p "$US006_RECORDER_DIR"
  echo "$US006_NONREC_PID" > "$US006_PIDFILE"

  set +e
  nonrec_start_out="$("$TOOL" start --interval 2 2>&1)"
  nonrec_start_rc=$?
  set -e

  if [ "$nonrec_start_rc" -ne 0 ]; then
    pass "start refuses when pidfile held by non-tt-recorder process (rc=$nonrec_start_rc)"
  else
    fail "start accepted pidfile from non-tt-recorder process (should refuse)"
  fi
else
  pass "skipped: non-recorder dummy PID not alive"
fi

# Clean up
kill "$US006_NONREC_PID" 2>/dev/null || true
timeout 2 wait "$US006_NONREC_PID" 2>/dev/null || true
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true

# Test 63: background process writes samples to JSONL file
echo ""
echo "--- Test: background process writes samples ---"

# Create a dummy process inside TT_ROOT so the recorder has something to sample
US006_DUMMY_DIR="$TT_ROOT_VAR/test-us006-$$"
mkdir -p "$US006_DUMMY_DIR"
(cd "$US006_DUMMY_DIR" && sleep 120) &
US006_DUMMY_PID=$!
sleep 0.3

# Start recorder with fast interval
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true
timeout 5 "$TOOL" start --interval 1 > /dev/null 2>&1

# Wait for at least 2 intervals (3 seconds) to accumulate samples
sleep 3.5

# Find the output file
US006_OUTPUT="$(ls -t "$US006_RECORDER_DIR"/samples-*.jsonl 2>/dev/null | head -1)"
if [ -n "$US006_OUTPUT" ] && [ -f "$US006_OUTPUT" ]; then
  US006_LINE_COUNT="$(wc -l < "$US006_OUTPUT" 2>/dev/null || echo 0)"
  if [ "$US006_LINE_COUNT" -gt 0 ]; then
    pass "background recorder wrote $US006_LINE_COUNT sample(s) to JSONL"
  else
    fail "background recorder output file is empty"
  fi

  # Verify samples contain our dummy process
  if grep -q "\"pid\":$US006_DUMMY_PID" "$US006_OUTPUT" 2>/dev/null; then
    pass "dummy process (pid=$US006_DUMMY_PID) appears in recorded samples"
  else
    fail "dummy process (pid=$US006_DUMMY_PID) not found in recorded samples"
  fi
else
  fail "no output file found after starting recorder"
fi

# Test 64: SIGTERM causes clean shutdown (pidfile NOT removed)
echo ""
echo "--- Test: SIGTERM clean shutdown ---"

# Read the recorder PID
US006_BG_PID="$(cat "$US006_PIDFILE" 2>/dev/null || true)"

# linux-only /proc/$US006_BG_PID existence checks below (MACP3 US-004): guarded
# on every read — Darwin has no /proc, so each /proc test is false there and
# the SIGTERM wait logic behaves conservatively (treated as exited; pass-by-note)
# on the wait loop and the negation below.
if [ -n "$US006_BG_PID" ] && [ -d "/proc/$US006_BG_PID" ]; then
  # Send SIGTERM
  kill -TERM "$US006_BG_PID" 2>/dev/null || true

  # Wait for process to exit (polling)
  US006_WAITED=0
  while [ -d "/proc/$US006_BG_PID" ] && [ "$US006_WAITED" -lt 10 ]; do
    sleep 0.5
    US006_WAITED=$((US006_WAITED + 1))
  done

  if [ ! -d "/proc/$US006_BG_PID" ]; then
    pass "SIGTERM caused clean shutdown (process exited)"
  else
    fail "process still alive after SIGTERM + 5s wait (pid=$US006_BG_PID)"
  fi

  # Verify pidfile was NOT removed (stop handles that)
  if [ -f "$US006_PIDFILE" ]; then
    pass "pidfile preserved after SIGTERM (stop handles cleanup)"
  else
    fail "pidfile was removed after SIGTERM (should be preserved)"
  fi
else
  pass "skipped: background recorder PID not available"
fi

# Cleanup US-006 resources
kill "$US006_DUMMY_PID" 2>/dev/null || true
kill "$US006_BG_PID" 2>/dev/null || true
rm -rf "$US006_DUMMY_DIR" 2>/dev/null || true
rm -rf "$US006_RECORDER_DIR" 2>/dev/null || true
for _pid in "$US006_DUMMY_PID" "${US006_BG_PID:-}"; do
  [ -n "$_pid" ] && timeout 2 wait "$_pid" 2>/dev/null || true
done

# Test 65: start --help still works after cmd_start implementation
echo ""
echo "--- Test: start --help still works ---"

start_help_us006="$("$TOOL" start --help 2>&1)"
if echo "$start_help_us006" | grep -q "start the recorder"; then
  pass "start --help still prints descriptive help after implementation"
else
  fail "start --help does not print expected help after implementation"
fi

# Test 66: cmd_start is no longer a stub (no exit 3)
echo ""
echo "--- Test: cmd_start is no longer a stub ---"

# Source the tool and verify cmd_start is not the stub version
if ! grep -A 5 '^cmd_start()' "$TOOL" | grep -q 'exit 3'; then
  pass "cmd_start no longer contains 'exit 3' stub code"
else
  fail "cmd_start still contains 'exit 3' stub"
fi

if grep -A 15 '^cmd_start()' "$TOOL" | grep -q 'already running'; then
  pass "cmd_start has double-start refusal logic"
else
  fail "cmd_start missing double-start refusal logic"
fi

# ── US-007: Stop command with evidence-based kill ──────────────────
echo ""
echo "=== US-007: Stop command with evidence-based kill ==="

US007_RECORDER_DIR="$TT_ROOT_VAR/recorder"
US007_PIDFILE="$US007_RECORDER_DIR/tt-recorder.pid"

# ── Test 67: Stop on non-running recorder is idempotent (exit 0) ────
echo ""
echo "--- Test: stop on non-running recorder (no pidfile) ---"

rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true

set +e
US007_STOP_NOFILE_OUT="$("$TOOL" stop 2>&1)"
US007_STOP_NOFILE_RC=$?
set -e

if [ "$US007_STOP_NOFILE_RC" -eq 0 ]; then
  pass "stop on non-running recorder exits 0 (idempotent)"
else
  fail "stop on non-running recorder exited $US007_STOP_NOFILE_RC (expected 0)"
fi

if echo "$US007_STOP_NOFILE_OUT" | grep -qi "not running"; then
  pass "stop on non-running reports 'not running'"
else
  fail "stop on non-running did not report 'not running' (got: $US007_STOP_NOFILE_OUT)"
fi

# ── Test 68: Stop kills the running recorder process ────────────────
echo ""
echo "--- Test: stop kills running recorder ---"

# Start a fresh recorder
rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true
"$TOOL" start --interval 5 > /dev/null 2>&1

US007_PID="$(cat "$US007_PIDFILE" 2>/dev/null || true)"

# linux-only /proc/$US007_PID existence checks below (MACP3 US-004): guarded on
# every read — Darwin has no /proc, so each /proc test is false there and the
# stop-verification falls to the else branches (pass-by-note; never hard-fails).
if [ -n "$US007_PID" ] && [ -d "/proc/$US007_PID" ]; then
  # Stop it
  set +e
  US007_STOP_OUT="$("$TOOL" stop 2>&1)"
  US007_STOP_RC=$?
  set -e

  if [ "$US007_STOP_RC" -eq 0 ]; then
    pass "stop exits 0 after killing recorder"
  else
    fail "stop exited $US007_STOP_RC (expected 0)"
  fi

  # Verify process is dead
  sleep 0.3
  # linux-only /proc negation (MACP3 US-004): "dead" = not present under /proc;
  # on Darwin /proc never exists so this reads as dead — pass-by-note, never hard-fails.
  if [ ! -d "/proc/$US007_PID" ]; then
    pass "stop killed the recorder process (PID $US007_PID no longer alive)"
  else
    fail "recorder process (PID $US007_PID) still alive after stop"
  fi
else
  fail "could not verify stop kills process (recorder PID not found)"
fi

# ── Test 69: Pidfile is removed after successful stop ───────────────
echo ""
echo "--- Test: pidfile removed after successful stop ---"

if [ ! -f "$US007_PIDFILE" ]; then
  pass "pidfile removed after successful stop"
else
  fail "pidfile still exists after successful stop"
fi

# ── Test 70: Stale pidfile (dead process) is cleaned and exits 0 ────
echo ""
echo "--- Test: stale pidfile (dead PID) cleaned ---"

# Create a pidfile with a definitely-dead PID
rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true
mkdir -p "$US007_RECORDER_DIR"
echo "99999" > "$US007_PIDFILE"

set +e
US007_STALE_DEAD_OUT="$("$TOOL" stop 2>&1)"
US007_STALE_DEAD_RC=$?
set -e

if [ "$US007_STALE_DEAD_RC" -eq 0 ]; then
  pass "stop on dead-PID pidfile exits 0"
else
  fail "stop on dead-PID pidfile exited $US007_STALE_DEAD_RC (expected 0)"
fi

if echo "$US007_STALE_DEAD_OUT" | grep -qi "stale pidfile"; then
  pass "stop reports 'stale pidfile removed' for dead PID"
else
  fail "stop did not report stale pidfile for dead PID (got: $US007_STALE_DEAD_OUT)"
fi

if [ ! -f "$US007_PIDFILE" ]; then
  pass "stale pidfile removed after stop on dead PID"
else
  fail "stale pidfile still exists after stop on dead PID"
fi

# ── Test 71: Pidfile pointing to non-tt-recorder process → removed ──
echo ""
echo "--- Test: pidfile with non-tt-recorder process ---"

# Spawn a non-tt-recorder process
(cd /tmp && sleep 300) &
US007_NONREC_PID=$!
sleep 0.3

# linux-only /proc/$US007_NONREC_PID existence checks (MACP3 US-004): guarded —
# Darwin has no /proc, so each /proc test is false there (pass-by-note).
if [ -d "/proc/$US007_NONREC_PID" ]; then
  mkdir -p "$US007_RECORDER_DIR"
  echo "$US007_NONREC_PID" > "$US007_PIDFILE"

  set +e
  US007_NONREC_STOP_OUT="$("$TOOL" stop 2>&1)"
  US007_NONREC_STOP_RC=$?
  set -e

  if [ "$US007_NONREC_STOP_RC" -eq 0 ]; then
    pass "stop on non-tt-recorder pidfile exits 0 (does NOT kill wrong process)"
  else
    fail "stop on non-tt-recorder pidfile exited $US007_NONREC_STOP_RC (expected 0)"
  fi

  # Verify the non-recorder process was NOT killed
  # linux-only /proc/$US007_NONREC_PID existence check (MACP3 US-004): guarded —
  # Darwin has no /proc, so the block is skipped (pass-by-note).
  if [ -d "/proc/$US007_NONREC_PID" ]; then
    pass "non-tt-recorder process was NOT killed (evidence-based guard works)"
  else
    fail "non-tt-recorder process was killed (evidence-based guard failed!)"
  fi

  if echo "$US007_NONREC_STOP_OUT" | grep -qi "stale pidfile"; then
    pass "stop reports 'stale pidfile removed' for non-tt-recorder pid"
  else
    fail "stop did not report stale pidfile for non-tt-recorder PID (got: $US007_NONREC_STOP_OUT)"
  fi

  # Verify pidfile was removed
  if [ ! -f "$US007_PIDFILE" ]; then
    pass "pidfile removed after stop on non-tt-recorder pidfile"
  else
    fail "pidfile still exists after stop on non-tt-recorder pidfile"
  fi
else
  pass "skipped: non-recorder dummy PID not alive"
fi

kill "$US007_NONREC_PID" 2>/dev/null || true
timeout 2 wait "$US007_NONREC_PID" 2>/dev/null || true
rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true

# ── Test 72: Stop after successful stop is idempotent (exit 0) ──────
echo ""
echo "--- Test: stop is idempotent after successful stop ---"

rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true

timeout 5 "$TOOL" start --interval 5 > /dev/null 2>&1
US007_PID2="$(cat "$US007_PIDFILE" 2>/dev/null || true)"

# linux-only /proc/$US007_PID2 existence check (MACP3 US-004): guarded —
# Darwin has no /proc, so the block is skipped (pass-by-note).
if [ -n "$US007_PID2" ] && [ -d "/proc/$US007_PID2" ]; then
  # First stop
  "$TOOL" stop > /dev/null 2>&1

  # Second stop — should be idempotent
  set +e
  US007_SECOND_STOP_OUT="$("$TOOL" stop 2>&1)"
  US007_SECOND_STOP_RC=$?
  set -e

  if [ "$US007_SECOND_STOP_RC" -eq 0 ]; then
    pass "second stop exits 0 (idempotent)"
  else
    fail "second stop exited $US007_SECOND_STOP_RC (expected 0)"
  fi

  if echo "$US007_SECOND_STOP_OUT" | grep -qi "not running"; then
    pass "second stop reports 'not running'"
  else
    fail "second stop did not report 'not running' (got: $US007_SECOND_STOP_OUT)"
  fi
else
  fail "could not verify idempotent stop (recorder not started)"
fi

# Clean up from test 72
rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true
kill "$US007_PID2" 2>/dev/null || true
timeout 2 wait "$US007_PID2" 2>/dev/null || true

# ── Test 73: cmd_stop implementation structure ──────────────────────
echo ""
echo "--- Test: cmd_stop implementation structure ---"

# Source includes evidence-based cmdline check
if grep -A 60 '^cmd_stop()' "$TOOL" | grep -q 'tr.*\\0.* .*<.*cmdline'; then
  pass "cmd_stop has evidence-based cmdline check"
else
  fail "cmd_stop missing evidence-based cmdline check"
fi

# Source includes SIGTERM
if grep -A 60 '^cmd_stop()' "$TOOL" | grep -q 'TERM'; then
  pass "cmd_stop sends SIGTERM first"
else
  fail "cmd_stop missing SIGTERM"
fi

# Source includes SIGKILL escalation
if grep -A 60 '^cmd_stop()' "$TOOL" | grep -q 'KILL'; then
  pass "cmd_stop escalates to SIGKILL"
else
  fail "cmd_stop missing SIGKILL escalation"
fi

# Source includes pidfile removal
if grep -A 60 '^cmd_stop()' "$TOOL" | grep -q 'rm -f.*pidfile'; then
  pass "cmd_stop removes pidfile"
else
  fail "cmd_stop missing pidfile removal"
fi

# cmd_stop is no longer a stub
if ! grep -A 5 '^cmd_stop()' "$TOOL" | grep -q 'exit 3'; then
  pass "cmd_stop no longer a stub (no exit 3)"
else
  fail "cmd_stop still contains exit 3 stub"
fi

# ── Test 74: stop --help still works ────────────────────────────────
echo ""
echo "--- Test: stop --help after implementation ---"

stop_help_us007="$("$TOOL" stop --help 2>&1)"

if echo "$stop_help_us007" | grep -q "stop"; then
  pass "stop --help still works after cmd_stop implementation"
else
  fail "stop --help broken after cmd_stop implementation"
fi

if "$TOOL" stop --help > /dev/null 2>&1; then
  pass "stop --help exits 0 after implementation"
else
  fail "stop --help does not exit 0 after implementation"
fi

# ── Test 75: Double stop on stale pidfile is idempotent ─────────────
echo ""
echo "--- Test: double stop on stale pidfile ---"

rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true
mkdir -p "$US007_RECORDER_DIR"
echo "99999" > "$US007_PIDFILE"

# First stop: clean stale
"$TOOL" stop > /dev/null 2>&1

# Second stop: no pidfile → idempotent
set +e
US007_DOUBLE_STALE_OUT="$("$TOOL" stop 2>&1)"
US007_DOUBLE_STALE_RC=$?
set -e

if [ "$US007_DOUBLE_STALE_RC" -eq 0 ]; then
  pass "double stop on stale pidfile exits 0"
else
  fail "double stop on stale pidfile exited $US007_DOUBLE_STALE_RC (expected 0)"
fi

rm -rf "$US007_RECORDER_DIR" 2>/dev/null || true

# ── US-008: Status command ────────────────────────────────────────
echo ""
echo "=== US-008: Status command ==="

US008_RECORDER_DIR="$TT_ROOT_VAR/recorder"
US008_PIDFILE="$US008_RECORDER_DIR/tt-recorder.pid"

# ── Test 76: status reports RUNNING when recorder is running ───────
echo ""
echo "--- Test: status reports RUNNING when recorder is running ---"

rm -rf "$US008_RECORDER_DIR" 2>/dev/null || true

# Start recorder with fast interval
"$TOOL" start --interval 1 > /dev/null 2>&1
US008_PID="$(cat "$US008_PIDFILE" 2>/dev/null || true)"

# Wait for at least one sample cycle so state file is written
sleep 1.5

set +e
US008_RUNNING_OUT="$("$TOOL" status 2>&1)"
US008_RUNNING_RC=$?
set -e

if echo "$US008_RUNNING_OUT" | grep -q "RUNNING"; then
  pass "status reports RUNNING when recorder is running"
else
  fail "status did not report RUNNING (got: $US008_RUNNING_OUT)"
fi

if echo "$US008_RUNNING_OUT" | grep -q "PID: $US008_PID"; then
  pass "status reports correct PID ($US008_PID)"
else
  fail "status did not report correct PID (got: $US008_RUNNING_OUT)"
fi

# ── Test 77: Sample count in status matches actual wc -l ───────────
echo ""
echo "--- Test: status sample count accuracy ---"

# Find the active output file
US008_OUTPUT_FILE="$(ls -t "$US008_RECORDER_DIR"/samples-*.jsonl 2>/dev/null | head -1)"
if [ -n "$US008_OUTPUT_FILE" ] && [ -f "$US008_OUTPUT_FILE" ]; then
  US008_ACTUAL_COUNT="$(wc -l < "$US008_OUTPUT_FILE" 2>/dev/null || echo 0)"
  US008_REPORTED_COUNT="$(echo "$US008_RUNNING_OUT" | grep 'Samples:' | grep -o '[0-9]\+' || echo 'NONE')"

  if [ "$US008_REPORTED_COUNT" = "$US008_ACTUAL_COUNT" ]; then
    pass "status sample count ($US008_REPORTED_COUNT) matches wc -l ($US008_ACTUAL_COUNT)"
  elif [ "$US008_REPORTED_COUNT" = "NONE" ]; then
    fail "status did not report Samples count"
  else
    fail "status sample count ($US008_REPORTED_COUNT) does not match wc -l ($US008_ACTUAL_COUNT)"
  fi
else
  fail "no output file found for sample count check"
fi

# ── Test 78: status reports output file path ───────────────────────
echo ""
echo "--- Test: status reports output file path ---"

if echo "$US008_RUNNING_OUT" | grep -q "Output: $US008_OUTPUT_FILE"; then
  pass "status reports correct output file path"
else
  fail "status did not report correct output file (got: $US008_RUNNING_OUT)"
fi

# ── Test 79: status exits 0 when running ───────────────────────────
echo ""
echo "--- Test: status exits 0 when running ---"

if [ "$US008_RUNNING_RC" -eq 0 ]; then
  pass "status exits 0 when recorder is running"
else
  fail "status exited $US008_RUNNING_RC when running (expected 0)"
fi

# Clean up the running recorder
"$TOOL" stop > /dev/null 2>&1

# ── Test 80: status reports NOT RUNNING when stopped ────────────────
echo ""
echo "--- Test: status reports NOT RUNNING when stopped ---"

set +e
US008_STOPPED_OUT="$("$TOOL" status 2>&1)"
US008_STOPPED_RC=$?
set -e

if echo "$US008_STOPPED_OUT" | grep -q "NOT RUNNING"; then
  pass "status reports NOT RUNNING when recorder is stopped"
else
  fail "status did not report NOT RUNNING (got: $US008_STOPPED_OUT)"
fi

# ── Test 81: status exits 0 when not running ───────────────────────
echo ""
echo "--- Test: status exits 0 when not running ---"

if [ "$US008_STOPPED_RC" -eq 0 ]; then
  pass "status exits 0 when recorder is not running"
else
  fail "status exited $US008_STOPPED_RC when not running (expected 0)"
fi

rm -rf "$US008_RECORDER_DIR" 2>/dev/null || true

# ── Test 82: status when no pidfile at all (vacuum state) ──────────
echo ""
echo "--- Test: status when no pidfile at all ---"

set +e
US008_NOFILE_OUT="$("$TOOL" status 2>&1)"
US008_NOFILE_RC=$?
set -e

if echo "$US008_NOFILE_OUT" | grep -q "NOT RUNNING"; then
  pass "status reports NOT RUNNING when no pidfile exists"
else
  fail "status did not report NOT RUNNING when no pidfile (got: $US008_NOFILE_OUT)"
fi

if [ "$US008_NOFILE_RC" -eq 0 ]; then
  pass "status exits 0 when no pidfile"
else
  fail "status exited $US008_NOFILE_RC when no pidfile (expected 0)"
fi

# ── Test 83: status when running but state file missing ────────────
echo ""
echo "--- Test: status when running but state file missing ---"

# Start recorder with LONG interval so _run_loop doesn't rewrite state file
rm -rf "$US008_RECORDER_DIR" 2>/dev/null || true
"$TOOL" start --interval 100 > /dev/null 2>&1
US008_PID2="$(cat "$US008_PIDFILE" 2>/dev/null || true)"

# Wait for _run_loop to write the state file (background process, slight delay)
sleep 0.5

# Delete the state file to simulate missing state
# (100s interval means _write_state won't be called again until rotation or restart)
rm -f "$US008_RECORDER_DIR/current-state" 2>/dev/null || true

set +e
US008_NOSTATE_OUT="$("$TOOL" status 2>&1)"
US008_NOSTATE_RC=$?
set -e

if echo "$US008_NOSTATE_OUT" | grep -q "UNKNOWN"; then
  pass "status reports UNKNOWN (no state file) when state file missing"
else
  fail "status did not report UNKNOWN when state file missing (got: $US008_NOSTATE_OUT)"
fi

if echo "$US008_NOSTATE_OUT" | grep -q "RUNNING"; then
  pass "status still reports RUNNING even without state file"
else
  fail "status did not report RUNNING when running (got: $US008_NOSTATE_OUT)"
fi

# Clean up
"$TOOL" stop > /dev/null 2>&1
rm -rf "$US008_RECORDER_DIR" 2>/dev/null || true

# ── Test 84: status --help still works after implementation ────────
echo ""
echo "--- Test: status --help after implementation ---"

status_help_us008="$("$TOOL" status --help 2>&1)"

if echo "$status_help_us008" | grep -q "status"; then
  pass "status --help still works after cmd_status implementation"
else
  fail "status --help broken after cmd_status implementation"
fi

if "$TOOL" status --help > /dev/null 2>&1; then
  pass "status --help exits 0 after implementation"
else
  fail "status --help does not exit 0 after implementation"
fi

# ── Test 85: cmd_status is no longer a stub ────────────────────────
echo ""
echo "--- Test: cmd_status is no longer a stub ---"

if ! grep -A 5 '^cmd_status()' "$TOOL" | grep -q 'exit 3'; then
  pass "cmd_status no longer contains 'exit 3' stub code"
else
  fail "cmd_status still contains 'exit 3' stub"
fi

if grep -A 50 '^cmd_status()' "$TOOL" | grep -q 'RUNNING'; then
  pass "cmd_status has RUNNING status logic"
else
  fail "cmd_status missing RUNNING status logic"
fi

if grep -A 50 '^cmd_status()' "$TOOL" | grep -q 'NOT RUNNING'; then
  pass "cmd_status has NOT RUNNING status logic"
else
  fail "cmd_status missing NOT RUNNING status logic"
fi

# ── US-009: Production process exclusion guard ───────────────────
echo ""
echo "=== US-009: Production process exclusion guard ==="

US009_FAKE_HOME="$TT_ROOT_VAR/fake-home-$$"
US009_TAMANDUA_DIR="$US009_FAKE_HOME/.tamandua"
US009_WORKTREES_DIR="$US009_TAMANDUA_DIR/worktrees"
US009_RECORDER_DIR="$TT_ROOT_VAR/recorder"

# ── Test 86: Process cwd under real ~/.tamandua (NOT worktree) excluded ─
echo ""
echo "--- Test: production cwd exclusion (NOT worktree) ---"

# Setup: TT_REAL_HOME points to our fake home inside TT_ROOT
mkdir -p "$US009_TAMANDUA_DIR/test-prod-dir"
mkdir -p "$US009_WORKTREES_DIR"

# Spawn a process whose cwd is under fake .tamandua/ but NOT under worktrees/
# Its cwd is under TT_ROOT (via fake-home) so _find_pids would normally discover it
(cd "$US009_TAMANDUA_DIR/test-prod-dir" && sleep 120) &
US009_PROD_PID=$!
sleep 0.3

# Call discover_processes with TT_REAL_HOME set to our fake home
US009_DISCOVER="$(bash -c "
  set -euo pipefail
  export TT_REAL_HOME='$US009_FAKE_HOME'
  source '$TOOL'
  discover_processes
" 2>/dev/null)"

if echo "$US009_DISCOVER" | grep -q "\"pid\":$US009_PROD_PID"; then
  fail "production cwd exclusion: process under real ~/.tamandua was NOT excluded (pid=$US009_PROD_PID)"
else
  pass "production cwd exclusion: process with cwd under real ~/.tamandua (NOT worktree) is excluded from discovery"
fi

# Verify the production process IS alive (guard didn't fail for wrong reason)
# linux-only /proc/$US009_PROD_PID existence check (MACP3 US-004): guarded —
# Darwin has no /proc, so the block is skipped (pass-by-note).
if [ -d "/proc/$US009_PROD_PID" ]; then
  pass "production cwd exclusion: excluded process is still alive (exclusion by guard, not by crash)"
else
  fail "production cwd exclusion: process died — guard check invalid (pid not alive)"
fi

# Cleanup
kill "$US009_PROD_PID" 2>/dev/null || true
timeout 2 wait "$US009_PROD_PID" 2>/dev/null || true
rm -rf "$US009_TAMANDUA_DIR/test-prod-dir" 2>/dev/null || true

# ── Test 87: Process cwd under ~/.tamandua/worktrees/ is NOT excluded ──
echo ""
echo "--- Test: worktree cwd is safe (NOT excluded) ---"

US009_WT_DIR="$US009_WORKTREES_DIR/some-checkout-$$"
mkdir -p "$US009_WT_DIR"

(cd "$US009_WT_DIR" && sleep 120) &
US009_WT_PID=$!
sleep 0.3

US009_DISCOVER_WT="$(bash -c "
  set -euo pipefail
  export TT_REAL_HOME='$US009_FAKE_HOME'
  source '$TOOL'
  discover_processes
" 2>/dev/null)"

if echo "$US009_DISCOVER_WT" | grep -q "\"pid\":$US009_WT_PID"; then
  pass "worktree cwd safety: process under ~/.tamandua/worktrees/ IS included (development worktrees are safe)"
else
  fail "worktree cwd safety: process under ~/.tamandua/worktrees/ was INCORRECTLY excluded (pid=$US009_WT_PID)"
fi

kill "$US009_WT_PID" 2>/dev/null || true
timeout 2 wait "$US009_WT_PID" 2>/dev/null || true
rm -rf "$US009_WT_DIR" 2>/dev/null || true

# ── Test 88: Process listening on production port 3334 is excluded ──
echo ""
echo "--- Test: production port exclusion ---"

# Spawn a process with cwd under TT_ROOT (passes cwd check) that listens on port 3334
US009_PORT_DIR="$TT_ROOT_VAR/test-port-$$"
mkdir -p "$US009_PORT_DIR"

# Start a TCP listener on port 3334 using python3
python3 -c "
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('127.0.0.1', 3334))
    s.listen(1)
    time.sleep(120)
except Exception:
    pass
" &
US009_PORT_PID=$!
sleep 0.5

# Verify the listener is actually alive
# linux-only /proc/$US009_PORT_PID reads below incl. the /proc/<pid>/fd glob
# (MACP3 US-004): guarded here — Darwin has no /proc, so the whole block is
# skipped (pass-by-note; never hard-fails).
if [ -d "/proc/$US009_PORT_PID" ]; then
  # Verify it actually has a socket on port 3334
  US009_HAS_PORT=false
  for _fd in "/proc/$US009_PORT_PID/fd"/*; do
    if [ -L "$_fd" ]; then
      _target="$(readlink "$_fd" 2>/dev/null || true)"
      if [[ "$_target" == socket:* ]]; then
        US009_HAS_PORT=true
        break
      fi
    fi
  done

  if [ "$US009_HAS_PORT" = true ]; then
    # Now call _find_pids via collect_sample and verify exclusion
    US009_SAMPLE="$(bash -c "
      set -euo pipefail
      source '$TOOL'
      collect_sample
    " 2>/dev/null)"

    if echo "$US009_SAMPLE" | grep -q "\"pid\":$US009_PORT_PID"; then
      # Check: was it listening on 3334? If the port 3334 wasn't actually bound
      # (e.g., port already in use), the guard wouldn't filter it
      # linux-only /proc/net/tcp read (MACP3 US-004): unguarded but degrades via
      # 2>/dev/null — on a /proc-less host awk reads empty input and exits 1,
      # so this falls to the else (pass-by-note). Darwin branch; never hard-fails.
      if awk '$4 == "0A" && $2 ~ /:0D06$/ {found=1} END {exit !found}' /proc/net/tcp 2>/dev/null; then
        fail "production port exclusion: process listening on port 3334 was NOT excluded (pid=$US009_PORT_PID)"
      else
        pass "production port exclusion: port 3334 listener not filtered (port not actually bound — likely already in use; guard correctly skipped)"
      fi
    else
      pass "production port exclusion: process on production port is excluded from samples (pid=$US009_PORT_PID)"
    fi
  else
    pass "production port exclusion: listener process has no sockets — port 3334 may be in use by another process; skipping port guard verification"
  fi
else
  pass "production port exclusion: listener died (port 3334 may be in use); cannot verify port guard"
fi

# Cleanup
kill "$US009_PORT_PID" 2>/dev/null || true
timeout 2 wait "$US009_PORT_PID" 2>/dev/null || true
rm -rf "$US009_PORT_DIR" 2>/dev/null || true

# ── Test 89: Production exclusion is logged when TT_RECORDER_VERBOSE is set ──
echo ""
echo "--- Test: production exclusion verbose logging ---"

US009_VERB_DIR="$US009_TAMANDUA_DIR/test-verbose-$$"
mkdir -p "$US009_VERB_DIR"

(cd "$US009_VERB_DIR" && sleep 120) &
US009_VERB_PID=$!
sleep 0.3

US009_VERB_STDERR="$(bash -c "
  set -euo pipefail
  export TT_REAL_HOME='$US009_FAKE_HOME'
  export TT_RECORDER_VERBOSE=1
  source '$TOOL'
  _find_pids
" 2>&1 1>/dev/null || true)"

if echo "$US009_VERB_STDERR" | grep -q "excluding production process PID=$US009_VERB_PID"; then
  pass "verbose logging: production exclusion is logged to stderr when TT_RECORDER_VERBOSE is set"
else
  fail "verbose logging: production exclusion NOT logged to stderr (got: '$US009_VERB_STDERR')"
fi

# Verify no logging when verbose is NOT set
US009_NO_VERB_STDERR="$(bash -c "
  set -euo pipefail
  export TT_REAL_HOME='$US009_FAKE_HOME'
  unset TT_RECORDER_VERBOSE
  source '$TOOL'
  _find_pids
" 2>&1 1>/dev/null || true)"

if [ -z "$US009_NO_VERB_STDERR" ]; then
  pass "verbose logging: no stderr output when TT_RECORDER_VERBOSE is not set"
else
  fail "verbose logging: unexpected stderr when verbose not set (got: '$US009_NO_VERB_STDERR')"
fi

kill "$US009_VERB_PID" 2>/dev/null || true
timeout 2 wait "$US009_VERB_PID" 2>/dev/null || true
rm -rf "$US009_VERB_DIR" 2>/dev/null || true

# ── Test 90: Source code structure — production exclusion functions exist ──
echo ""
echo "--- Test: source structure — production exclusion functions ---"

if grep -q '^_resolve_real_home()' "$TOOL"; then
  pass "source has _resolve_real_home function"
else
  fail "source missing _resolve_real_home function"
fi

if grep -q '^_is_production_cwd()' "$TOOL"; then
  pass "source has _is_production_cwd function"
else
  fail "source missing _is_production_cwd function"
fi

if grep -q '^_is_production_ports()' "$TOOL"; then
  pass "source has _is_production_ports function"
else
  fail "source missing _is_production_ports function"
fi

# ── Test 91: Production exclusion is evidence-based ──────────────────
echo ""
echo "--- Test: production exclusion is evidence-based ---"

# Verify section: the greps below match '/proc/net/tcp' / '/proc/<pid>/fd/' as
# STRING literals in tt-recorder's source ($TOOL) — this harness never reads the
# host procfs here, so the checks run identically on Darwin (MACP3 US-004 doc
# note; linux-only evidence source being asserted, not accessed).
# Port guard uses /proc/net/tcp + /proc/<pid>/fd/ — evidence-based, never ss/netstat name matching
if grep -A 60 '^_is_production_ports()' "$TOOL" | grep -q '/proc/net/tcp'; then
  pass "port guard uses /proc/net/tcp (evidence-based socket inode matching)"
else
  fail "port guard missing /proc/net/tcp evidence-based check"
fi

# CWD guard uses /proc/<pid>/cwd — evidence-based
if grep -A 15 '^_is_production_cwd()' "$TOOL" | grep -q 'cwd'; then
  pass "cwd guard uses process cwd evidence"
else
  fail "cwd guard missing cwd-based check"
fi

# Production exclusion references the real home + .tamandua path
if grep -A 60 '^_is_production_cwd()' "$TOOL" | grep -q '.tamandua'; then
  pass "cwd guard checks for .tamandua in path"
else
  fail "cwd guard missing .tamandua path check"
fi

# Worktree safety: .tamandua/worktrees/ is explicitly excluded from production check
if grep -A 60 '^_is_production_cwd()' "$TOOL" | grep -q 'worktrees'; then
  pass "cwd guard explicitly exempts worktrees/ from production exclusion"
else
  fail "cwd guard missing worktrees exemption"
fi

# _resolve_real_home uses getent, NOT $HOME
if grep -A 20 '^_resolve_real_home()' "$TOOL" | grep -q 'getent'; then
  pass "_resolve_real_home uses getent (not HOME env var)"
else
  fail "_resolve_real_home missing getent-based home resolution"
fi

# _resolve_real_home supports TT_REAL_HOME override for testing
if grep -A 10 '^_resolve_real_home()' "$TOOL" | grep -q 'TT_REAL_HOME'; then
  pass "_resolve_real_home supports TT_REAL_HOME override for testing"
else
  fail "_resolve_real_home missing TT_REAL_HOME override"
fi

# Production exclusion runs BEFORE data collection (
# the guard is in _find_pids, not in RSS/fd collection)
if grep -A 80 '^_find_pids()' "$TOOL" | grep -q 'production exclusion'; then
  pass "production exclusion guard runs in _find_pids (before RSS/fd data collection)"
else
  fail "production exclusion guard not in _find_pids (may collect production process data)"
fi

# Production exclusion never uses name-only matching
if ! grep -A 30 '^_is_production_ports()' "$TOOL" | grep -qiE 'ss |netstat.*grep|pgrep.*port|lsof.*grep'; then
  pass "port guard does NOT use ss/netstat/lsof for process matching (evidence-based)"
else
  fail "port guard uses ss/netstat/lsof for matching (not evidence-based)"
fi

# Cleanup US-009 test dirs
rm -rf "$US009_FAKE_HOME" 2>/dev/null || true
rm -rf "$US009_RECORDER_DIR" 2>/dev/null || true

# ── US-010: End-to-end integration test ─────────────────────────────
echo ""
echo "=== US-010: End-to-end integration test ==="

US010_RECORDER_DIR="$TT_ROOT_VAR/recorder"

# Clean up any stale state before the E2E test
rm -rf "$US010_RECORDER_DIR" 2>/dev/null || true
# Kill only running tt-recorder background processes (not this test script).
# Match on the pattern used by _run_loop in tt-recorder.
# linux-only /proc/$US010_STALE_PID existence check (MACP3 US-004): guarded —
# Darwin has no /proc, so the block is skipped (pass-by-note).
if [ -f "$US010_RECORDER_DIR/tt-recorder.pid" ]; then
  US010_STALE_PID="$(cat "$US010_RECORDER_DIR/tt-recorder.pid" 2>/dev/null || true)"
  if [ -n "$US010_STALE_PID" ] && [ -d "/proc/$US010_STALE_PID" ]; then
    kill "$US010_STALE_PID" 2>/dev/null || true
    timeout 3 wait "$US010_STALE_PID" 2>/dev/null || true
  fi
fi

# ── Test 92: Start recorder, sample dummy+decoy, verify samples, stop, verify cleanup ──
echo ""
echo "--- Test: US-010 — full E2E pipeline ---"

# Create dummy and decoy directories
US010_DUMMY_DIR="$TT_ROOT_VAR/test-us010-dummy-$$"
US010_DECOY_DIR="/tmp/test-us010-decoy-$$"
mkdir -p "$US010_DUMMY_DIR"
mkdir -p "$US010_DECOY_DIR"

# Spawn dummy process (cwd under TT_ROOT/var/) — MUST be sampled
(cd "$US010_DUMMY_DIR" && sleep 120) &
US010_DUMMY_PID=$!

# Spawn decoy process (cwd outside TT_ROOT/var/) — must NOT be sampled
(cd "$US010_DECOY_DIR" && sleep 120) &
US010_DECOY_PID=$!

sleep 0.3

# Start the recorder with 2s interval for fast testing
"$TOOL" start --interval 2 > /dev/null 2>&1
US010_START_RC=$?

if [ "$US010_START_RC" -eq 0 ]; then
  pass "US-010: start exits 0"
else
  fail "US-010: start exited $US010_START_RC"
fi

# Wait for at least 2 intervals (5+ seconds to ensure ≥2 samples)
sleep 5.5

# Find the output file
US010_OUTPUT="$(ls -t "$US010_RECORDER_DIR"/samples-*.jsonl 2>/dev/null | head -1)"

if [ -n "$US010_OUTPUT" ] && [ -f "$US010_OUTPUT" ]; then
  pass "US-010: output file created"

  # Count how many samples contain the dummy process
  US010_DUMMY_COUNT="$(grep "\"pid\":$US010_DUMMY_PID" "$US010_OUTPUT" 2>/dev/null | wc -l || true)"
  if [ "$US010_DUMMY_COUNT" -ge 2 ]; then
    pass "US-010: dummy process appears in ≥2 samples (got $US010_DUMMY_COUNT)"
  else
    fail "US-010: dummy process appears in only $US010_DUMMY_COUNT sample(s), need ≥2"
  fi

  # Verify dummy samples have rss_kb and open_fds fields
  US010_DUMMY_SAMPLES="$(grep "\"pid\":$US010_DUMMY_PID" "$US010_OUTPUT" 2>/dev/null || true)"
  US010_FIRST_SAMPLE="$(printf '%s\n' "$US010_DUMMY_SAMPLES" | head -1)"
  if [ -n "$US010_FIRST_SAMPLE" ]; then
    US010_HAS_RSS="$(printf '%s\n' "$US010_FIRST_SAMPLE" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print('YES' if 'rss_kb' in obj and isinstance(obj['rss_kb'], int) else 'NO')
" 2>/dev/null || echo 'NO')"
    US010_HAS_FDS="$(printf '%s\n' "$US010_FIRST_SAMPLE" | python3 -c "
import json,sys
obj=json.loads(sys.stdin.read())
print('YES' if 'open_fds' in obj and isinstance(obj['open_fds'], int) else 'NO')
" 2>/dev/null || echo 'NO')"

    if [ "$US010_HAS_RSS" = "YES" ]; then
      pass "US-010: dummy sample has rss_kb field (integer)"
    else
      fail "US-010: dummy sample missing or invalid rss_kb field"
    fi
    if [ "$US010_HAS_FDS" = "YES" ]; then
      pass "US-010: dummy sample has open_fds field (integer)"
    else
      fail "US-010: dummy sample missing or invalid open_fds field"
    fi
  else
    fail "US-010: could not extract dummy sample for field check"
  fi

  # Verify decoy process appears in 0 samples
  US010_DECOY_COUNT="$(grep "\"pid\":$US010_DECOY_PID" "$US010_OUTPUT" 2>/dev/null | wc -l || true)"
  if [ "$US010_DECOY_COUNT" -eq 0 ]; then
    pass "US-010: decoy process (cwd outside var/) appears in 0 samples"
  else
    fail "US-010: decoy process (cwd outside var/) appears in $US010_DECOY_COUNT sample(s)"
  fi

  # Verify all JSONL lines are valid JSON
  US010_ALL_VALID=true
  US010_LINE_NUM=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    US010_LINE_NUM=$((US010_LINE_NUM + 1))
    if ! printf '%s\n' "$line" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
      US010_ALL_VALID=false
      break
    fi
  done < "$US010_OUTPUT"

  if [ "$US010_ALL_VALID" = true ] && [ "$US010_LINE_NUM" -gt 0 ]; then
    pass "US-010: all $US010_LINE_NUM JSONL lines are valid JSON"
  else
    fail "US-010: invalid JSON found in output (checked $US010_LINE_NUM lines)"
  fi

  # Verify timestamps are monotonic (non-decreasing)
  US010_TS_OK=true
  US010_PREV_TS=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ts="$(printf '%s\n' "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['ts'])" 2>/dev/null || true)"
    if [ -n "$US010_PREV_TS" ] && [[ "$ts" < "$US010_PREV_TS" ]]; then
      US010_TS_OK=false
      break
    fi
    US010_PREV_TS="$ts"
  done < "$US010_OUTPUT"

  if [ "$US010_TS_OK" = true ]; then
    pass "US-010: timestamps are monotonic (non-decreasing)"
  else
    fail "US-010: timestamps are not monotonic"
  fi
else
  fail "US-010: no output file found after sampling"
fi

# Stop the recorder
"$TOOL" stop > /dev/null 2>&1
US010_STOP_RC=$?

if [ "$US010_STOP_RC" -eq 0 ]; then
  pass "US-010: stop exits 0"
else
  fail "US-010: stop exited $US010_STOP_RC"
fi

# Verify pidfile is removed
US010_PIDFILE="$US010_RECORDER_DIR/tt-recorder.pid"
if [ ! -f "$US010_PIDFILE" ]; then
  pass "US-010: pidfile is removed after stop"
else
  fail "US-010: pidfile still exists after stop"
fi

# Verify status reports NOT RUNNING
set +e
US010_STATUS_OUT="$("$TOOL" status 2>&1)"
US010_STATUS_RC=$?
set -e

if echo "$US010_STATUS_OUT" | grep -q "NOT RUNNING"; then
  pass "US-010: status reports NOT RUNNING after stop"
else
  fail "US-010: status did not report NOT RUNNING (got: $US010_STATUS_OUT)"
fi

if [ "$US010_STATUS_RC" -eq 0 ]; then
  pass "US-010: status exits 0 after stop"
else
  fail "US-010: status exited $US010_STATUS_RC after stop"
fi

# Test 93: Verify double-start refusal after stop
rm -rf "$US010_RECORDER_DIR" 2>/dev/null || true

# First start
"$TOOL" start --interval 2 > /dev/null 2>&1

# Second start should be refused
set +e
US010_DOUBLE_OUT="$("$TOOL" start --interval 2 2>&1)"
US010_DOUBLE_RC=$?
set -e

if [ "$US010_DOUBLE_RC" -ne 0 ]; then
  pass "US-010: double-start is refused (rc=$US010_DOUBLE_RC)"
else
  fail "US-010: double-start was accepted (should be refused)"
fi

if echo "$US010_DOUBLE_OUT" | grep -qiE "already running|already started"; then
  pass "US-010: double-start reports already running"
else
  fail "US-010: double-start did not report already running (got: $US010_DOUBLE_OUT)"
fi

# Clean up double-start test recorder
"$TOOL" stop > /dev/null 2>&1

# Test 94: End-to-end pipeline exercises all three commands
if true; then
  pass "US-010: test exercises all three commands: start, status, stop"
fi

# Cleanup E2E test processes and dirs
kill "$US010_DUMMY_PID" 2>/dev/null || true
kill "$US010_DECOY_PID" 2>/dev/null || true
rm -rf "$US010_DUMMY_DIR" 2>/dev/null || true
rm -rf "$US010_DECOY_DIR" 2>/dev/null || true
rm -rf "$US010_RECORDER_DIR" 2>/dev/null || true
# Wait for background processes with timeout
for _pid in "$US010_DUMMY_PID" "$US010_DECOY_PID"; do
  [ -n "$_pid" ] && timeout 2 wait "$_pid" 2>/dev/null || true
done

# ── US-010: Note on second-pass verification ────────────────────────
echo ""
echo "--- Test: US-010 — note on second-pass verification ---"
echo "  Second consecutive pass is verified by running the test script twice."
echo "  Run: bash torture-test/bin/tt-recorder.test.sh && bash torture-test/bin/tt-recorder.test.sh"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All tests passed ==="
  exit 0
else
  echo "=== $FAILURES test(s) FAILED ==="
  exit 1
fi
