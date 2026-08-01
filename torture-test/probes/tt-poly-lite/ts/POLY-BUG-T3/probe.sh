#!/usr/bin/env bash
# Probe: POLY-BUG-T3 — red-herring ordering bug in update() (A3 archetype)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: bug (A3 — symptom points to UI, root cause in store.ts)
#
# Checks:
#   1. store.ts update() replaces in-place (no splice + push ordering corruption)
#   2. Regression test exists for order preservation after update
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../../fixtures-src/tt-poly-lite/ts/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/POLY-BUG-T3.patch"
TS_WORKSPACE="$WORKSPACE/ts"

# ── 1. store.ts update() replaces in-place ──
echo "[] Checking update() ordering behavior..." >&2
STORE_FILE="$TS_WORKSPACE/src/store.ts"
check_file_exists "$STORE_FILE" "store.ts not found in workspace"

# The buggy code uses splice+push; fixed code assigns to index directly
assert_not_grep "splice.*push\|splice.*index.*push" "$STORE_FILE" \
    "POLY-BUG-T3 not fixed: store.ts update() still uses splice+push pattern (order corruption)"

# Should have in-place assignment: this.#expenses[index] = updated
assert_grep "expenses\[index\] = updated\|expenses\[index\] =" "$STORE_FILE" \
    "POLY-BUG-T3 not fixed: store.ts update() does not replace in-place"

# ── 2. Regression test exists for order preservation ──
echo "[] Checking for regression test..." >&2
check_regression_test "$TS_WORKSPACE" "regression.*POLY-BUG-T3\|BUG-T3.*update\|preserves.*order.*update\|getAll.*after.*update" \
    "POLY-BUG-T3: no regression test found for order preservation after update()"

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "0 fail"; then
    fail "POLY-BUG-T3: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-t3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "POLY-BUG-T3 revert-probe: failed to apply seed patch"
fi

# Regression test must fail (bug re-introduced)
if run_in_workspace "$REVERT_SCRATCH/ts" npm test 2>&1 | grep -q "0 fail"; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-T3 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression test caught the re-introduced bug" >&2

pass_ "POLY-BUG-T3: update() replaces in-place, order preserved, regression test exists and passes, revert-probe passed"
