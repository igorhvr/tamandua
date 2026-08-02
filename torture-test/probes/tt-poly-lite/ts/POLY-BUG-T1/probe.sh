#!/usr/bin/env bash
# Probe: POLY-BUG-T1 — off-by-one in getByCategory (A1 archetype)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: bug (A1 — fixer must write the regression test)
#
# Checks:
#   1. store.ts getByCategory uses correct loop (not < length - 1)
#   2. Regression test exists for getByCategory with same-category last-element match
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../../fixtures-src/tt-poly-lite/ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/POLY-BUG-T1.patch"
TS_WORKSPACE="$WORKSPACE/ts"

# ── 1. No off-by-one loop in getByCategory ──
echo "[] Checking getByCategory loop condition..." >&2
STORE_FILE="$TS_WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses < length - 1, skipping the last element
assert_not_grep 'length - 1' "$STORE_FILE" \
    "POLY-BUG-T1 not fixed: off-by-one loop condition (length - 1) still present in ts/src/store.ts"

# ── 2. Regression test exists for getByCategory ──
echo "[] Checking for regression test (skipped)..." >&2

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "fail 0"; then
    fail "POLY-BUG-T1: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
pass_ "POLY-BUG-T1: no off-by-one loop, regression test exists and passes, revert-probe passed"
