#!/usr/bin/env bash
# Probe: BRK-G1 — broken test: off-by-one expected result count (N-1 instead of N)
# Fixture: tt-go
# Task type: broken-test
#
# Checks:
#   1. pool_test.go does NOT contain the broken off-by-one assertion
#   2. go test ./... exits 0 (all tests pass)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/pool_test.go"
check_file_exists "$TEST_FILE" "pool_test.go not found in workspace"

# ── 1. Verify fix: no off-by-one expected count (n-1) ──
echo "[] Checking for correct expected result count..." >&2

# The broken test expected n-1 results instead of n.
# The fix corrects the expected count. Look for patterns like:
# "expected %d results" with correct count, not off-by-one.
assert_not_grep 'len(results) != n-1\|\blen(results) != n - 1' "$TEST_FILE" \
    "BRK-G1 not fixed: test still expects n-1 results instead of n"

# ── 2. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BRK-G1: test suite still has failures"
fi

pass_ "BRK-G1: expected result count corrected from n-1 to n, go test passes"
