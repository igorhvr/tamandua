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
echo "[] Checking for regression test..." >&2
check_regression_test "$TS_WORKSPACE" "regression.*POLY-BUG-T1\|BUG-T1.*getByCategory\|last.*element.*category\|returns all matching" \
    "POLY-BUG-T1: no regression test found for getByCategory with last-element match"

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "0 fail"; then
    fail "POLY-BUG-T1: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-t1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "POLY-BUG-T1 revert-probe: failed to apply seed patch"
fi

# Regression test must fail (bug re-introduced)
if run_in_workspace "$REVERT_SCRATCH/ts" npm test 2>&1 | grep -q "0 fail"; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-T1 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression test caught the re-introduced bug" >&2

pass_ "POLY-BUG-T1: no off-by-one loop, regression test exists and passes, revert-probe passed"
