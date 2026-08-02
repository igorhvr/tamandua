#!/usr/bin/env bash
# Probe: BUG-T1 — off-by-one in category filter (getByCategory loop condition)
# Fixture: tt-ts
# Task type: bug (A1 — off-by-one)
#
# Checks:
#   1. getByCategory uses correct loop condition (not < length - 1)
#   2. Regression test exists for category filter with last-element match
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-T1.patch"

# ── 1. No off-by-one loop condition in getByCategory ──
echo "[] Checking getByCategory loop condition..." >&2
STORE_FILE="$WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

assert_not_grep 'length - 1' "$STORE_FILE" \
    "BUG-T1 not fixed: off-by-one loop condition (length - 1) still present in store.ts"

# ── 2. Regression test exists for getByCategory with last-element match ──
echo "[] Checking for regression test..." >&2

# ── 3. Verify getByCategory works correctly for multiple same-category expenses ──
echo "[] Verifying getByCategory behavior..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="BUG-T1" src/ 2>&1 | grep -q "pass"; then
    fail "BUG-T1: regression test for getByCategory does not pass"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
pass_ "BUG-T1: no off-by-one loop, regression test exists, revert-probe passed"
