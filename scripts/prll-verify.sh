#!/usr/bin/env bash
# PRLL Verification: runs the full test suite multiple times in both
# "before" (all tests at default concurrency) and "after" (serial+parallel lanes)
# configurations, records wall-clock time and pass/fail status, and generates
# a summary report.
#
# Environment variables:
#   PRLL_RUN_COUNT     Number of iterations per config (default: 5)
#   TAMANDUA_REPO_ROOT Override repo root for testability
#   TAMANDUA_TEST_GUARD     (default: 1)
#   TAMANDUA_PI_BINARY      (default: /usr/bin/false)
#
# Usage:
#   ./scripts/prll-verify.sh           # run 5 before + 5 after
#   PRLL_RUN_COUNT=2 ./scripts/prll-verify.sh  # quick check

REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
RUN_COUNT="${PRLL_RUN_COUNT:-5}"
TAMANDUA_TMP="${TAMANDUA_TEST_TMPDIR:-/tmp/tamandua-test}"
RESULT_DIR="${TAMANDUA_TMP}/prll-verify-$$"
mkdir -p "$RESULT_DIR"

# ----- helpers -----
timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
HOST_CPUS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 'unknown')"

bg_tamandua_count() {
  pgrep -cf 'tamandua' 2>/dev/null || true
}

echo "=== PRLL Verification Run ==="
echo "Repo:     $REPO_ROOT"
echo "Host:     $(hostname) | CPUs: $HOST_CPUS"
echo "Date:     $(timestamp)"
echo "Bg load:  $(bg_tamandua_count) tamandua procs"
echo "Iterations: ${RUN_COUNT} per config"
echo ""

# ----- RUNNER -----
# Runs a test suite command and records timing and status.
# Returns the status string via stdout; timing written to timefile.
run_suite() {
  local label="$1"
  local cmd="$2"
  local outfile="${RESULT_DIR}/${label// /_}.txt"
  local timefile="${RESULT_DIR}/${label// /_}_time.txt"

  echo ">>> $(timestamp) $label" >&2
  local start_sec
  start_sec=$(date +%s)

  local rc=0
  eval "$cmd" >"$outfile" 2>&1 || rc=$?

  local end_sec
  end_sec=$(date +%s)
  local elapsed=$((end_sec - start_sec))
  local elapsed_fmt
  elapsed_fmt=$(printf '%d:%02d' $((elapsed / 60)) $((elapsed % 60)))

  echo "$elapsed" >"$timefile"

  if [ "$rc" -eq 0 ]; then
    echo "    PASSED" >&2
    echo "    Duration: ${elapsed_fmt} (${elapsed}s)" >&2
    echo "" >&2
    echo "PASSED"
  else
    echo "    FAILED (exit $rc)" >&2
    echo "    Duration: ${elapsed_fmt} (${elapsed}s)" >&2
    echo "" >&2
    echo "FAILED"
  fi
}

# ----- RUN LOOP -----
run_config() {
  local config_name="$1"   # "before" or "after"
  local config_label="$2"  # human-readable description
  local config_cmd="$3"    # command to run per iteration

  echo "===== ${config_label} =====" >&2
  echo "" >&2

  local pass_count=0
  local fail_count=0
  local -a times=()
  local -a statuses=()

  for i in $(seq 1 "$RUN_COUNT"); do
    echo "--- ${config_label} run #${i} ---" >&2

    if [ "$config_name" = "before" ]; then
      # Count files for info
      local files
      files=$(find src tests -name '*.test.ts' ! -path '*/e2e-tests/*' | sort)
      echo "    Files: $(echo "$files" | grep -c '.' || echo 0)" >&2
    fi

    local status
    status=$(run_suite "${config_name}_${i}" "$config_cmd")
    statuses+=("$status")

    local elapsed
    elapsed=$(cat "${RESULT_DIR}/${config_name}_${i}_time.txt")
    times+=("$elapsed")

    if [ "$status" = "PASSED" ]; then
      pass_count=$((pass_count + 1))
    else
      fail_count=$((fail_count + 1))
    fi
  done

  # Calculate average
  local sum=0
  for t in "${times[@]}"; do
    sum=$((sum + t))
  done
  local avg=$((sum / RUN_COUNT))
  local avg_fmt
  avg_fmt=$(printf '%d:%02d' $((avg / 60)) $((avg % 60)))

  # Report section (to stderr so it appears on terminal)
  echo "" >&2
  echo "--- ${config_label} ---" >&2
  local idx=0
  while [ $idx -lt "${#times[@]}" ]; do
    local t="${times[$idx]}"
    local s="${statuses[$idx]}"
    local t_fmt
    t_fmt=$(printf '%d:%02d' $((t / 60)) $((t % 60)))
    echo "  Run #$((idx+1)): $s  (${t_fmt}, ${t}s)" >&2
    idx=$((idx + 1))
  done
  echo "  => ${pass_count}/${RUN_COUNT} passed, ${fail_count}/${RUN_COUNT} failed" >&2
  echo "  => Average wall-clock: ${avg_fmt} (${avg}s)" >&2

  # Output results as machine-parseable key:value lines (to stdout for capture)
  echo "RESULT_${config_name}_pass=$pass_count"
  echo "RESULT_${config_name}_fail=$fail_count"
  echo "RESULT_${config_name}_avg=$avg"
}

# Find test files once for BEFORE runs
BEFORE_FILES=$(find src tests -name '*.test.ts' ! -path '*/e2e-tests/*' | sort)
BEFORE_FILE_COUNT=$(echo "$BEFORE_FILES" | grep -c '.' || echo 0)

# ----- BEFORE -----
BEFORE_OUTPUT=$(run_config "before" \
  "BEFORE (all tests, default concurrency)" \
  "TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false node --test \$BEFORE_FILES")

# Parse BEFORE results
BEFORE_PASS=$(echo "$BEFORE_OUTPUT" | grep '^RESULT_before_pass=' | cut -d= -f2)
BEFORE_FAIL=$(echo "$BEFORE_OUTPUT" | grep '^RESULT_before_fail=' | cut -d= -f2)
BEFORE_AVG=$(echo "$BEFORE_OUTPUT" | grep '^RESULT_before_avg=' | cut -d= -f2)

# ----- AFTER -----
AFTER_OUTPUT=$(run_config "after" \
  "AFTER (npm test: serial+parallel lanes)" \
  "npm test")

# Parse AFTER results
AFTER_PASS=$(echo "$AFTER_OUTPUT" | grep '^RESULT_after_pass=' | cut -d= -f2)
AFTER_FAIL=$(echo "$AFTER_OUTPUT" | grep '^RESULT_after_fail=' | cut -d= -f2)
AFTER_AVG=$(echo "$AFTER_OUTPUT" | grep '^RESULT_after_avg=' | cut -d= -f2)

# ----- REPORT -----
echo ""
echo "============================================"
echo "=== PRLL VERIFICATION REPORT ==="
echo "============================================"
echo "Date:     $(timestamp)"
echo "CPUs:     $HOST_CPUS"
echo ""

echo "--- Rotating Flake Assessment ---"
if [ "${AFTER_FAIL:-0}" -eq 0 ]; then
  echo "  RESULT: Zero failures in AFTER verification (${AFTER_PASS}/${RUN_COUNT} clean)"
else
  echo "  RESULT: ${AFTER_FAIL}/${RUN_COUNT} AFTER runs had failures"
  # Extract failing test names from after runs
  for i in $(seq 1 "$RUN_COUNT"); do
    OUTFILE="${RESULT_DIR}/after_${i}.txt"
    if [ -f "$OUTFILE" ] && grep -qE '(^✖ |^not ok |^# fail )' "$OUTFILE" 2>/dev/null; then
      echo "  AFTER run #${i} failures:"
      grep -E '(^✖ |^not ok |^# fail )' "$OUTFILE" | head -20 | sed 's/^/    /' || true
    fi
  done
fi
echo ""

echo "--- Before Failure Details ---"
for i in $(seq 1 "$RUN_COUNT"); do
  OUTFILE="${RESULT_DIR}/before_${i}.txt"
  if [ -f "$OUTFILE" ] && grep -qE '(^✖ |^not ok |^# fail )' "$OUTFILE" 2>/dev/null; then
    echo "  BEFORE run #${i} failures:"
    grep -E '(^✖ |^not ok |^# fail )' "$OUTFILE" | head -20 | sed 's/^/    /' || true
  fi
done
echo ""

echo "--- Cost of Serialization ---"
BEFORE_AVG_N=${BEFORE_AVG:-0}
AFTER_AVG_N=${AFTER_AVG:-0}
BEFORE_AVG_FMT=$(printf '%d:%02d' $((BEFORE_AVG_N / 60)) $((BEFORE_AVG_N % 60)))
AFTER_AVG_FMT=$(printf '%d:%02d' $((AFTER_AVG_N / 60)) $((AFTER_AVG_N % 60)))
echo "  BEFORE avg: ${BEFORE_AVG_FMT} (${BEFORE_AVG_N}s)"
echo "  AFTER  avg: ${AFTER_AVG_FMT} (${AFTER_AVG_N}s)"
DELTA=$((AFTER_AVG_N - BEFORE_AVG_N))
if [ "$DELTA" -ge 0 ]; then
  DELTA_SIGN="+"
else
  DELTA_SIGN=""
fi
if [ "$BEFORE_AVG_N" -gt 0 ]; then
  DELTA_PCT=$(( (AFTER_AVG_N - BEFORE_AVG_N) * 100 / BEFORE_AVG_N ))
  echo "  Delta: ${DELTA_SIGN}${DELTA}s (${DELTA_PCT}%)"
else
  echo "  Delta: ${DELTA_SIGN}${DELTA}s"
fi
echo ""

echo "--- Raw logs ---"
echo "  $RESULT_DIR"
echo ""

# Exit 0 if AFTER was clean; non-zero otherwise
if [ "${AFTER_FAIL:-0}" -eq 0 ]; then
  echo "VERDICT: PASS — serial lane eliminates rotating flake class"
  exit 0
else
  echo "VERDICT: FAIL — AFTER runs had failures (see above for details)"
  exit 1
fi
