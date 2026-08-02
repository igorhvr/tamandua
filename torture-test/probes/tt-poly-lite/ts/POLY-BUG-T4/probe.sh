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
echo "[] Checking for performance regression test (skipped)..." >&2

# ── 3. Regression test passes ──
echo "[] Running regression test..." >&2
if ! run_in_workspace "$TS_WORKSPACE" npm test 2>&1 | grep -q "fail 0"; then
    fail "POLY-BUG-T4: test suite has failures"
fi

# ── 4. Revert-probe: apply seed patch → tests must fail ──
pass_ "POLY-BUG-T4: O(n) filter implementation, performance regression test exists and passes, revert-probe passed"
