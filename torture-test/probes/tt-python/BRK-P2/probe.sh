#!/usr/bin/env bash
# Probe: BRK-P2 — broken test: conflict count mismatch
# Fixture: tt-python
# Task type: broken-test
#
# Checks:
#   1. test_broken_p2.py exists
#   2. Pytest exits 0 for test_broken_p2.py (all assertions pass)
#   3. Expected counts corrected: 2, 0, 0 (not 1, 1, 1)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/tests/test_broken_p2.py"

# ── 1. Test file exists ──
check_file_exists "$TEST_FILE" "test_broken_p2.py not found — broken test was not created/fixed"

# ── 2. Verify fix: expected counts are 2, 0, 0 (not 1, 1, 1) ──
echo "[] Checking expected counts in test_broken_p2.py..." >&2

# The broken version had len(conflicts) == 1 for all three tests
# The fixed version should have == 2, == 0, == 0
assert_not_grep 'len(conflicts) == 1' "$TEST_FILE" \
    "BRK-P2 not fixed: old broken assertion 'len(conflicts) == 1' still present"

# Check that at least one corrected count exists
if ! grep -q 'len(conflicts) == 2' "$TEST_FILE"; then
    fail "BRK-P2 not fixed: expected count 2 not found (test_conflicts_among_overlapping_events should expect 2 conflicts)"
fi

if ! grep -q 'len(conflicts) == 0' "$TEST_FILE"; then
    fail "BRK-P2 not fixed: expected count 0 not found (empty list and non-overlapping cases should expect 0 conflicts)"
fi

# ── 3. Run pytest — must pass ──
echo "[] Running test_broken_p2.py..." >&2
if ! run_python_tests "$WORKSPACE" "tests/test_broken_p2.py" 2>&1; then
    fail "BRK-P2: test_broken_p2.py still has failing assertions"
fi

pass_ "BRK-P2: test_broken_p2.py passes, expected conflict counts corrected (2, 0, 0)"
