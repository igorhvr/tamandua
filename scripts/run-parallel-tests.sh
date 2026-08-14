#!/bin/bash
# Run parallel-lane tests (all non-serial test files) with default concurrency.
# Excludes files listed in tests/serial-files.txt and e2e-tests/.
# Passes through TAMANDUA_TEST_GUARD, TAMANDUA_PI_BINARY, and
# TAMANDUA_DSH_BINARY env vars.
# Exit code: 0 on pass, non-zero on any failure.
#
# Portability: must run under bash 3.2 (macOS /bin/bash) — no associative
# arrays (declare -A), no mapfile/readarray.
set -euo pipefail

# Determine repo root (parent of scripts/ dir)
REPO_ROOT="${TAMANDUA_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

# Default env vars if not set
export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"
export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"
export TAMANDUA_DSH_BINARY="${TAMANDUA_DSH_BINARY:-/usr/bin/false}"

# Read serial files to exclude: newline-delimited absolute paths.
SERIAL_FILES_LIST="$REPO_ROOT/tests/serial-files.txt"
SERIAL_SET=$'\n'

if [ -f "$SERIAL_FILES_LIST" ]; then
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi
    SERIAL_SET="$SERIAL_SET$REPO_ROOT/$line"$'\n'
  done < "$SERIAL_FILES_LIST"
fi

# Find all .test.ts files under src/ and tests/, excluding serial and e2e
FILES=()
while IFS= read -r -d '' file; do
  if [[ "$SERIAL_SET" == *$'\n'"$file"$'\n'* ]]; then
    continue
  fi
  if [[ "$file" == */e2e-tests/* ]]; then
    continue
  fi
  FILES+=("$file")
done < <(find "$REPO_ROOT/src" "$REPO_ROOT/tests" -name '*.test.ts' -print0 2>/dev/null)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Error: no parallel test files found" >&2
  exit 1
fi

echo "=== Parallel lane: running ${#FILES[@]} test files with default concurrency ==="
node --test "${FILES[@]}"
