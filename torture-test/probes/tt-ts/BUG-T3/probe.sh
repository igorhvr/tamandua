#!/usr/bin/env bash
# Probe: BUG-T3 — red-herring ordering bug (update splices + pushes, corrupting order)
# Fixture: tt-ts
# Task type: bug (A3 — red-herring)
#
# Checks:
#   1. store.ts update() replaces in-place (no splice + push ordering corruption)
#   2. Regression test exists for ordering preservation after update
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-T3.patch"

# ── 1. store.ts update() replaces in-place ──
echo "[] Checking update() ordering behavior..." >&2
STORE_FILE="$WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses splice+push; fixed code assigns to index directly
# Key check: the fixed code should NOT have splice+push pattern
assert_not_grep "splice.*push\|splice.*index.*push" "$STORE_FILE" \
    "BUG-T3 not fixed: store.ts update() still uses splice+push pattern (order corruption)"

# Should have in-place assignment pattern: this.#expenses[index] = updated
assert_grep "expenses\[index\] = updated\|expenses\[index\] =" "$STORE_FILE" \
    "BUG-T3 not fixed: store.ts update() does not replace in-place"

# ── 2. Regression test exists for order preservation ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "regression BUG-T3\|preserves.*order.*update\|getAll.*after.*update" \
    "BUG-T3: no regression test found for order preservation after update()"

# ── 3. Run BUG-T3 regression test — must pass ──
echo "[] Running BUG-T3 regression test..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="BUG-T3" src/ 2>&1; then
    fail "BUG-T3: order preservation regression test does not pass"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-t3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-T3 revert-probe: failed to apply seed patch"
fi

# Run the regression test — must fail (bug re-introduced, test catches it)
if run_in_workspace "$REVERT_SCRATCH" npx tsx --test --test-name-pattern="BUG-T3" src/ 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: order preservation test passed after re-introducing BUG-T3 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression test caught the re-introduced bug" >&2

pass_ "BUG-T3: update() replaces in-place, order preserved, regression test exists, revert-probe passed"
