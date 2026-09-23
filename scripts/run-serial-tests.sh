#!/bin/bash
# Run serial-lane tests with concurrency 1.
# Reads tests/serial-files.txt for the list of serial test files.
# Passes through TAMANDUA_TEST_GUARD, TAMANDUA_PI_BINARY,
# TAMANDUA_DSH_BINARY, and TAMANDUA_HERMES_BINARY env vars.
# Exit code: 0 on pass, non-zero on any failure.
set -euo pipefail

# Determine repo root (parent of scripts/ dir)
REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

# Default env vars if not set
export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"
export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"
export TAMANDUA_DSH_BINARY="${TAMANDUA_DSH_BINARY:-/usr/bin/false}"
export TAMANDUA_HERMES_BINARY="${TAMANDUA_HERMES_BINARY:-/usr/bin/false}"

# Read serial files, filtering out comments and empty lines
SERIAL_FILES_LIST="$REPO_ROOT/tests/serial-files.txt"

if [ ! -f "$SERIAL_FILES_LIST" ]; then
  echo "Error: $SERIAL_FILES_LIST not found" >&2
  exit 1
fi

# Collect serial files from the list
FILES=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"   # trim leading whitespace
  line="${line%"${line##*[![:space:]]}"}"   # trim trailing whitespace
  if [ -z "$line" ] || [[ "$line" == \#* ]]; then
    continue
  fi
  FILES+=("$REPO_ROOT/$line")
done < "$SERIAL_FILES_LIST"

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Error: no serial test files found in $SERIAL_FILES_LIST" >&2
  exit 1
fi

echo "=== Serial lane: running ${#FILES[@]} test files with concurrency 1 ==="

# Per-run guard-violation ledger: the test-isolation guard appends one JSONL
# line per violation to TAMANDUA_TEST_GUARD_LEDGER; guard-ledger-report.mjs
# prints them grouped by originating test file (dropping the guard's own
# expected self-test provocations) and exits non-zero when any real
# violations remain. Lane-fail enforcement: a non-empty ledger FAILS this
# lane even when node's tests themselves passed — test-isolation violations
# must never pass silently.
LEDGER_FILE="$(mktemp -t "tamandua-guard-ledger-$$.jsonl" 2>/dev/null || mktemp)"
export TAMANDUA_TEST_GUARD_LEDGER="$LEDGER_FILE"

# Capture node's TAP output while still streaming it: `tee` writes the stream
# to a temp file the negative-TAP gate audits below. `set +e` lets the pipeline
# finish so PIPESTATUS can carry node's true exit status through the tee; it is
# re-enabled immediately after.
NODE_TAP_FILE="$(mktemp -t "tamandua-node-tap-$$.tap" 2>/dev/null || mktemp)"
NODE_EXIT=0
set +e
node --experimental-test-module-mocks --test --test-concurrency=1 "${FILES[@]}" 2>&1 | tee "$NODE_TAP_FILE"
NODE_EXIT="${PIPESTATUS[0]}"
set -e

# Enforcement: run the ledger report (it prints grouped violations to stderr
# and exits 1 when any non-expected entry exists). A non-zero report exit
# fails the lane regardless of NODE_EXIT; with an empty ledger the lane exits
# with node's own exit code.
REPORT_EXIT=0
if [ -f "$REPO_ROOT/scripts/guard-ledger-report.mjs" ]; then
  node "$REPO_ROOT/scripts/guard-ledger-report.mjs" "$LEDGER_FILE" >&2 || REPORT_EXIT=$?
fi
rm -f -- "$LEDGER_FILE"
if [ "$REPORT_EXIT" -ne 0 ]; then
  rm -f -- "$NODE_TAP_FILE"
  echo ">>> Serial lane FAILED: test-isolation violations detected (see report above)" >&2
  exit 1
fi

# NHFG negative-TAP gate: Node 22.23.1 can print a top-level or nested
# `not ok` record (or a `hookFailed` diagnostic) for a failed after-hook while
# the run summary reports fail 0 and the process exits 0. An exit-code-only
# gate would false-green, so fail the lane on any such record even when
# NODE_EXIT is 0. `ok ... # SKIP` / `# TODO` records stay green. The
# hookFailed alternative is anchored to a TAP diagnostic (`# hookFailed`) so a
# test title merely containing that word can never trip the gate.
TAP_FAILURES="$(grep -E '^[[:space:]]*not ok |^[[:space:]]*#[[:space:]]*hookFailed' "$NODE_TAP_FILE" || true)"
if [ -n "$TAP_FAILURES" ]; then
  rm -f -- "$NODE_TAP_FILE"
  echo ">>> Serial lane FAILED: negative TAP records present despite node exit $NODE_EXIT" >&2
  printf '%s\n' "$TAP_FAILURES" >&2
  exit 1
fi
rm -f -- "$NODE_TAP_FILE"
exit "$NODE_EXIT"
