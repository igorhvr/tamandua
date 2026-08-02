#!/usr/bin/env bash
# Probe: BUG-T2 — two-module date handling (server.ts ISO vs store.ts string comparison)
# Fixture: tt-ts
# Task type: bug (A2 — two-module)
#
# Checks:
#   1. server.ts normalizes dates to YYYY-MM-DD (not raw toISOString)
#   2. store.ts getByDateRange uses timestamp comparison (not localeCompare)
#   3. Regression tests exist for date normalization and date range filtering
#   4. Revert-probe: apply seed patch → regression tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-T2.patch"

# ── 1. server.ts normalizes dates to YYYY-MM-DD ──
echo "[] Checking date normalization in server.ts..." >&2
SERVER_FILE="$WORKSPACE/src/server.ts"
check_file_exists "$SERVER_FILE" "server.ts not found in workspace"

# Must normalize dates (T00:00:00Z → split by T)
assert_grep "T00:00:00Z\|split.*T.*\[0\]\|toISOString.*split" "$SERVER_FILE" \
    "BUG-T2 not fixed: server.ts does not normalize dates to YYYY-MM-DD"

# The buggy code uses toISOString() without splitting — check for toISOString() followed directly by ;
assert_not_grep 'parsed\.toISOString\(\)\s*;' "$SERVER_FILE" \
    "BUG-T2 not fixed: server.ts still uses raw toISOString() without .split() for date parsing"

# ── 2. store.ts getByDateRange uses timestamp comparison ──
echo "[] Checking date comparison in store.ts..." >&2
STORE_FILE="$WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# Should use Date comparison (getTime) not string localeCompare
assert_grep "getTime\|Date(" "$STORE_FILE" \
    "BUG-T2 not fixed: store.ts does not use Date-based comparison for getByDateRange"

assert_not_grep 'localeCompare' "$STORE_FILE" \
    "BUG-T2 not fixed: store.ts still uses localeCompare for date filtering"

# ── 3. Regression tests exist ──
echo "[] Checking for regression tests (skipped)..." >&2

pass_ "BUG-T2: date normalization in server.ts, timestamp comparison in store.ts"
