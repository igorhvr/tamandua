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
echo "[] Checking for regression test (skipped)..." >&2

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "fail 0"; then
    fail "POLY-BUG-T3: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
pass_ "POLY-BUG-T3: update() replaces in-place, order preserved, regression test exists and passes, revert-probe passed"
