#!/usr/bin/env bash
# Probe: BUG-J4 — performance bug (O(n²) getCategoryTotals)
# Fixture: tt-java
# Task type: bug (A4 — performance)
#
# Checks:
#   1. LedgerService.getCategoryTotals() uses O(n) Map.merge, not nested loop
#   2. Performance regression test exists
#   3. Revert-probe: apply seed patch → performance test fails (times out)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-java/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-J4.patch"

LEDGER_SVC="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. getCategoryTotals uses O(n) merge, not nested loop ──
echo "[] Checking getCategoryTotals implementation..." >&2
check_file_exists "$LEDGER_SVC" "LedgerService.java not found in workspace"

# The O(n) fix uses Map.merge; the O(n²) bug uses nested for-each loops
assert_grep 'merge' "$LEDGER_SVC" \
    "BUG-J4 not fixed: getCategoryTotals does not use Map.merge (may still be O(n²))"

# ── 2. Performance regression test exists ──
echo "[] Checking for performance regression test..." >&2
check_regression_test "$WORKSPACE" "regressionBugJ4CategoryTotalsPerformance\|regressionBugJ4" \
    "BUG-J4: no performance regression test found"

# ── 3. Revert-probe: apply seed patch → performance test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-j4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-J4 revert-probe: failed to apply seed patch"
fi

# Run the performance regression test — must fail (O(n²) times out)
if (cd "$REVERT_SCRATCH" && ./mvnw -q -B test -Dtest="LedgerServiceTest#regressionBugJ4CategoryTotalsPerformance" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: performance test passed after re-introducing BUG-J4 O(n²) bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: performance test caught the re-introduced O(n²) bug" >&2

pass_ "BUG-J4: O(n) merge in getCategoryTotals, performance regression test exists, revert-probe passed"
