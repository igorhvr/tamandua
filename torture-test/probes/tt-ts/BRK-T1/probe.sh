#!/usr/bin/env bash
# Probe: BRK-T1 — broken store test assertion (getTotal expects 150 instead of 60)
# Fixture: tt-ts
# Task type: broken-test
#
# Checks:
#   1. store.test.ts getTotal assertion expects 60 (not 150)
#   2. Full test suite passes (0 failures)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/src/store.test.ts"
check_file_exists "$TEST_FILE" "store.test.ts not found in workspace"

# ── 1. Correct expected value in getTotal assertion ──
echo "[] Checking getTotal expected value..." >&2

# The broken version: assert.strictEqual(store.getTotal(), 150)
# The fixed version: assert.strictEqual(store.getTotal(), 60)
assert_not_grep 'getTotal.*,\s*150' "$TEST_FILE" \
    "BRK-T1 not fixed: getTotal assertion still expects 150 (should be 60)"

assert_grep 'getTotal.*,\s*60' "$TEST_FILE" \
    "BRK-T1 not fixed: getTotal assertion does not expect 60"

# ── 2. Full test suite passes ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test src/ 2>&1; then
    fail "BRK-T1: test suite still has failures"
fi

pass_ "BRK-T1: getTotal assertion expects 60, full test suite passes"
