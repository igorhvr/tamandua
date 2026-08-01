#!/usr/bin/env bash
# Probe: BRK-P1 — broken test: date mismatch in add_business_days assertions
# Fixture: tt-python
# Task type: broken-test
#
# Checks:
#   1. test_broken_p1.py exists
#   2. Pytest exits 0 for test_broken_p1.py (all assertions pass)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/tests/test_broken_p1.py"

# ── 1. Test file exists ──
check_file_exists "$TEST_FILE" "test_broken_p1.py not found — broken test was not created/fixed"

# ── 2. Verify the fix is present (expected dates corrected) ──
echo "[] Checking expected dates in test_broken_p1.py..." >&2
# The broken version had date(2026, 7, 31) and date(2026, 8, 1)
# The fixed version should have date(2026, 8, 3) for both
assert_not_grep 'date(2026, 7, 31).*BROKEN\| = date(2026, 7, 31)' "$TEST_FILE" \
    "BRK-P1 not fixed: old broken assertion (date 2026-07-31) still present"
assert_not_grep 'date(2026, 8, 1)' "$TEST_FILE" \
    "BRK-P1 not fixed: old broken assertion (date 2026-08-01) still present"

# ── 3. Run pytest — must pass ──
echo "[] Running test_broken_p1.py..." >&2
if ! run_python_tests "$WORKSPACE" "tests/test_broken_p1.py" 2>&1; then
    fail "BRK-P1: test_broken_p1.py still has failing assertions"
fi

pass_ "BRK-P1: test_broken_p1.py passes, expected dates corrected from 7/31 and 8/1 to 8/3"
