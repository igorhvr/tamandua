#!/usr/bin/env bash
# Probe: POLY-BUG-T2 — two-module date handling (A2 archetype)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: bug (A2 — coordinated fix in server.ts + store.ts)
#
# Checks:
#   1. store.ts getByDateRange does not use localeCompare
#   2. Regression test exists for date-range filtering with cross-day boundary data
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../../fixtures-src/tt-poly-lite/ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/POLY-BUG-T2.patch"
TS_WORKSPACE="$WORKSPACE/ts"

# ── 1. store.ts getByDateRange does not use localeCompare ──
echo "[] Checking date handling in store.ts..." >&2
STORE_FILE="$TS_WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses localeCompare for date comparison (string comparison)
assert_not_grep 'localeCompare' "$STORE_FILE" \
    "POLY-BUG-T2 not fixed: store.ts getByDateRange still uses localeCompare for date filtering"

# ── 2. Regression test exists for date-range filtering ──
echo "[] Checking for regression test..." >&2
check_regression_test "$TS_WORKSPACE" "regression.*POLY-BUG-T2\|BUG-T2.*date.*range\|date.*boundary\|cross.*day" \
    "POLY-BUG-T2: no regression test found for date-range filtering across day boundaries"

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "0 fail"; then
    fail "POLY-BUG-T2: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-t2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "POLY-BUG-T2 revert-probe: failed to apply seed patch"
fi

# Regression test must fail (bug re-introduced)
if run_in_workspace "$REVERT_SCRATCH/ts" npm test 2>&1 | grep -q "0 fail"; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-T2 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression test caught the re-introduced bug" >&2

pass_ "POLY-BUG-T2: no localeCompare in date handling, regression test exists and passes, revert-probe passed"
