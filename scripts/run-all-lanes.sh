#!/bin/bash
# Run both serial and parallel test lanes.
# Serial lane runs first, parallel lane runs after.
# Both lanes always run regardless of the other's outcome.
# Exit code: 0 only when both lanes pass, non-zero when either fails.
set -uo pipefail

REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"
export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"

SERIAL_EXIT=0
PARALLEL_EXIT=0

echo ""
echo "============================================"
echo "  PRLL: Two-Lane Test Suite"
echo "============================================"
echo ""

# --- Serial Lane ---
echo ">>> Starting SERIAL lane (concurrency 1)..."
bash "$REPO_ROOT/scripts/run-serial-tests.sh" || SERIAL_EXIT=$?
echo ""

if [ "$SERIAL_EXIT" -eq 0 ]; then
  echo ">>> SERIAL lane: PASSED"
else
  echo ">>> SERIAL lane: FAILED (exit code $SERIAL_EXIT)"
fi
echo ""

# --- Parallel Lane ---
echo ">>> Starting PARALLEL lane (default concurrency)..."
bash "$REPO_ROOT/scripts/run-parallel-tests.sh" || PARALLEL_EXIT=$?
echo ""

if [ "$PARALLEL_EXIT" -eq 0 ]; then
  echo ">>> PARALLEL lane: PASSED"
else
  echo ">>> PARALLEL lane: FAILED (exit code $PARALLEL_EXIT)"
fi
echo ""

# --- Final Summary ---
echo "============================================"
echo "  PRLL Test Suite Summary"
echo "============================================"
echo "  Serial lane:   $([ "$SERIAL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED")"
echo "  Parallel lane: $([ "$PARALLEL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED")"
echo "============================================"

if [ "$SERIAL_EXIT" -eq 0 ] && [ "$PARALLEL_EXIT" -eq 0 ]; then
  exit 0
else
  exit 1
fi
