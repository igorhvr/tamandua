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

# The buggy code uses toISOString() without splitting — check that it's not the raw buggy version
assert_not_grep "date = parsed\.toISOString\(\)" "$SERVER_FILE" \
    "BUG-T2 not fixed: server.ts still uses raw toISOString() for date parsing"

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
echo "[] Checking for regression tests..." >&2
check_regression_test "$WORKSPACE" "regression BUG-T2" \
    "BUG-T2: no regression test found for date handling"

# ── 4. Run BUG-T2 regression tests — must pass ──
echo "[] Running BUG-T2 regression tests..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="BUG-T2" src/ 2>&1; then
    fail "BUG-T2: date handling regression tests do not pass"
fi

# ── 5. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-t2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-T2 revert-probe: failed to apply seed patch"
fi

# Run the regression test — must fail (bug re-introduced, test catches it)
if run_in_workspace "$REVERT_SCRATCH" npx tsx --test --test-name-pattern="BUG-T2" src/ 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: date handling regression tests passed after re-introducing BUG-T2 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests caught the re-introduced bug" >&2

pass_ "BUG-T2: date normalization in server.ts, timestamp comparison in store.ts, regression tests pass, revert-probe passed"
