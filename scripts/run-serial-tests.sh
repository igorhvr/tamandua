#!/bin/bash
# Run serial-lane tests with concurrency 1.
# Reads tests/serial-files.txt for the list of serial test files.
# Passes through TAMANDUA_TEST_GUARD and TAMANDUA_PI_BINARY env vars.
# Exit code: 0 on pass, non-zero on any failure.
set -euo pipefail

# Determine repo root (parent of scripts/ dir)
REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

# Default env vars if not set
export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"
export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"

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
node --experimental-test-module-mocks --test --test-concurrency=1 "${FILES[@]}"
