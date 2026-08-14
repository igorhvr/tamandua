#!/bin/bash
# Run both serial and parallel test lanes.
# Serial lane runs first, parallel lane runs after.
# Both lanes always run regardless of the other's outcome.
# Exit code: 0 when both lanes pass, 1 when either lane fails,
#   3 when tree drift detected (results void).
set -uo pipefail

REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

# --- Build ---
# Build dist/ so tests always run against the current source.
# TBLD: Prevents silent stale-dist false alarms (2026-07-11 incident).
BUILD_LOG=$(mktemp -t "tamandua-build-$$.log" 2>/dev/null || mktemp)
if npm run build > "$BUILD_LOG" 2>&1; then
  rm -f "$BUILD_LOG"
else
  echo "Build failed. Full log: $BUILD_LOG" >&2
  echo "--- Last 20 lines ---" >&2
  tail -n 20 "$BUILD_LOG" >&2
  echo "---" >&2
  exit 1
fi

# --- Tree Drift Detection: fingerprint the working tree after build ---
# If the repo changes mid-run, test results are chimeric and void.
DRIFT_DETECTED=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FINGERPRINT_HEAD=$(git rev-parse HEAD)
  FINGERPRINT_STATUS=$(git --no-optional-locks status --porcelain --untracked-files=no)
else
  FINGERPRINT_HEAD=""
  FINGERPRINT_STATUS=""
fi

export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"
export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"
export TAMANDUA_DSH_BINARY="${TAMANDUA_DSH_BINARY:-/usr/bin/false}"

# --- Syntax Gate ---
# Catch merge-artifact syntax errors (unbalanced braces, etc.) that
# lenient Node 22 parsers tolerate but stricter Node 24 rejects.
# Guard set -e: if the script is missing (isolated test env), skip silently.
SYNTAX_CHECK="$REPO_ROOT/scripts/syntax-check-tests.ts"
if [ -f "$SYNTAX_CHECK" ]; then
  echo ">>> Running syntax gate on .test.ts files..."
  if ! npx tsx "$SYNTAX_CHECK"; then
    echo ""
    echo ">>> Syntax gate FAILED — test files have parse errors. Fix before running tests." >&2
    exit 1
  fi
  echo ""
fi

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

# --- Serial drift check ---
if [ -n "$FINGERPRINT_HEAD" ]; then
  CHECK_HEAD=$(git rev-parse HEAD)
  CHECK_STATUS=$(git --no-optional-locks status --porcelain --untracked-files=no)
  if [ "$FINGERPRINT_HEAD" != "$CHECK_HEAD" ] || [ "$FINGERPRINT_STATUS" != "$CHECK_STATUS" ]; then
    DRIFT_DETECTED=1
    echo "" >&2
    echo "============================================" >&2
    echo "  TREE DRIFT DETECTED" >&2
    echo "============================================" >&2
    echo "  The repository changed while tests were running — RESULTS VOID" >&2
    echo "  HEAD before: $FINGERPRINT_HEAD" >&2
    echo "  HEAD after:  $CHECK_HEAD" >&2
    echo "  Status before: $FINGERPRINT_STATUS" >&2
    echo "  Status after:  $CHECK_STATUS" >&2
    echo "  Re-run npm test on a quiescent tree." >&2
    echo "============================================" >&2
    echo "" >&2
  fi
fi

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

# --- Parallel drift check ---
if [ -n "$FINGERPRINT_HEAD" ]; then
  CHECK_HEAD=$(git rev-parse HEAD)
  CHECK_STATUS=$(git --no-optional-locks status --porcelain --untracked-files=no)
  if [ "$FINGERPRINT_HEAD" != "$CHECK_HEAD" ] || [ "$FINGERPRINT_STATUS" != "$CHECK_STATUS" ]; then
    DRIFT_DETECTED=1
    echo "" >&2
    echo "============================================" >&2
    echo "  TREE DRIFT DETECTED" >&2
    echo "============================================" >&2
    echo "  The repository changed while tests were running — RESULTS VOID" >&2
    echo "  HEAD before: $FINGERPRINT_HEAD" >&2
    echo "  HEAD after:  $CHECK_HEAD" >&2
    echo "  Status before: $FINGERPRINT_STATUS" >&2
    echo "  Status after:  $CHECK_STATUS" >&2
    echo "  Re-run npm test on a quiescent tree." >&2
    echo "============================================" >&2
    echo "" >&2
  fi
fi

# --- Final Summary ---
echo "============================================"
echo "  PRLL Test Suite Summary"
echo "============================================"
if [ "$DRIFT_DETECTED" -eq 1 ]; then
  echo "  Tree drift:    DETECTED — RESULTS VOID (exit code 3)"
  echo "  Serial lane:   $([ "$SERIAL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED") (void)"
  echo "  Parallel lane: $([ "$PARALLEL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED") (void)"
  echo "============================================"
  echo "" >&2
  echo "  Re-run npm test on a quiescent tree." >&2
  exit 3
else
  echo "  Serial lane:   $([ "$SERIAL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED")"
  echo "  Parallel lane: $([ "$PARALLEL_EXIT" -eq 0 ] && echo "PASSED" || echo "FAILED")"
  echo "============================================"
fi

if [ "$SERIAL_EXIT" -eq 0 ] && [ "$PARALLEL_EXIT" -eq 0 ]; then
  exit 0
else
  exit 1
fi
