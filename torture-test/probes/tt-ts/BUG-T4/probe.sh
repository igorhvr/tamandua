#!/usr/bin/env bash
# Probe: BUG-T4 — performance degradation (O(n²) category filter)
# Fixture: tt-ts
# Task type: bug (A4 — performance)
#
# Checks:
#   1. getByCategory uses O(n) filter (not nested-loop JSON.stringify)
#   2. Regression test exists for performance threshold (under 50ms for 2000 expenses)
#   3. Revert-probe: apply seed patch → performance regression test fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-T4.patch"

# ── 1. getByCategory uses filter (not nested-loop JSON.stringify) ──
echo "[] Checking getByCategory implementation..." >&2
STORE_FILE="$WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses nested loops with JSON.stringify; fixed uses filter
assert_not_grep 'JSON\.stringify' "$STORE_FILE" \
    "BUG-T4 not fixed: store.ts getByCategory still uses JSON.stringify (O(n²) implementation)"

assert_grep '\.filter' "$STORE_FILE" \
    "BUG-T4 not fixed: store.ts getByCategory does not use Array.filter (O(n) implementation)"

# ── 2. Regression test exists for performance threshold ──
echo "[] Checking for performance regression test..." >&2
check_regression_test "$WORKSPACE" "regression BUG-T4\|under 50ms\|performance\.now" \
    "BUG-T4: no regression test found for performance threshold"

# ── 3. Run BUG-T4 regression test — must pass ──
echo "[] Running BUG-T4 performance regression test..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="BUG-T4" src/ 2>&1; then
    fail "BUG-T4: performance regression test does not pass"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-t4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-T4 revert-probe: failed to apply seed patch"
fi

# Run the regression test — must fail (bug re-introduced, performance test catches it)
if run_in_workspace "$REVERT_SCRATCH" npx tsx --test --test-name-pattern="BUG-T4" src/ 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: performance test passed after re-introducing BUG-T4 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: performance test caught the re-introduced bug" >&2

pass_ "BUG-T4: O(n) filter implementation, performance regression test exists and passes, revert-probe passed"
