#!/usr/bin/env bash
# Probe: POLY-BUG-T4 — O(n²) performance in getByCategory (A4 archetype)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: bug (A4 — passes small tests, fails large-input threshold)
#
# Checks:
#   1. store.ts getByCategory uses O(n) filter (not nested-loop JSON.stringify)
#   2. Regression test exists for performance threshold (under 50ms for 2000 expenses)
#   3. Revert-probe: apply seed patch → performance regression test fails

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../../fixtures-src/tt-poly-lite/ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/POLY-BUG-T4.patch"
TS_WORKSPACE="$WORKSPACE/ts"

# ── 1. getByCategory uses filter (not nested-loop JSON.stringify) ──
echo "[] Checking getByCategory implementation..." >&2
STORE_FILE="$TS_WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses nested loops with JSON.stringify; fixed uses filter
assert_not_grep 'JSON\.stringify' "$STORE_FILE" \
    "POLY-BUG-T4 not fixed: store.ts getByCategory still uses JSON.stringify (O(n²) implementation)"

assert_grep '\.filter' "$STORE_FILE" \
    "POLY-BUG-T4 not fixed: store.ts getByCategory does not use Array.filter (O(n) implementation)"

# ── 2. Regression test exists for performance threshold ──
echo "[] Checking for performance regression test..." >&2
check_regression_test "$TS_WORKSPACE" "regression.*POLY-BUG-T4\|BUG-T4.*perf\|under.*50ms\|performance.*now" \
    "POLY-BUG-T4: no regression test found for performance threshold"

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "0 fail"; then
    fail "POLY-BUG-T4: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-t4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "POLY-BUG-T4 revert-probe: failed to apply seed patch"
fi

# Regression test must fail (bug re-introduced, performance test catches it)
if run_in_workspace "$REVERT_SCRATCH/ts" npm test 2>&1 | grep -q "0 fail"; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-T4 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: performance test caught the re-introduced bug" >&2

pass_ "POLY-BUG-T4: O(n) filter implementation, performance regression test exists and passes, revert-probe passed"
