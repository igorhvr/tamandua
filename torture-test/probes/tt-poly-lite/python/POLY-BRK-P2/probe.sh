#!/usr/bin/env bash
# Probe: POLY-BRK-P2 — broken test: wrong conflict counts in assertions
# Fixture: tt-poly-lite (python/ subtree)
# Task type: broken-test
#
# Checks:
#   1. test_broken_p2.py exists
#   2. All three assertions corrected (no == 1 where should be != 1)
#   3. Pytest exits 0 for test_broken_p2.py

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"
TEST_FILE="$PY_WORKSPACE/tests/test_broken_p2.py"

# ── 1. Test file exists ──
check_file_exists "$TEST_FILE" "test_broken_p2.py not found — broken test was not created/fixed"

# ── 2. Verify the fix is present (all count assertions corrected) ──
echo "[] Checking conflict count assertions in test_broken_p2.py..." >&2

# The broken version had three assertions of `assert len(conflicts) == 1`
# The fixed version should have `== 2` for overlapping, `== 0` for empty/non-overlapping
# Check that at least one assertion has == 2 (the overlapping events case)
assert_grep 'len(conflicts).*== 2' "$TEST_FILE" \
    "POLY-BRK-P2 not fixed: conflict count for overlapping events should be 2"

# Check that some assertions have == 0 (empty list and non-overlapping cases)
assert_grep 'len(conflicts).*== 0' "$TEST_FILE" \
    "POLY-BRK-P2 not fixed: conflict count for empty/non-overlapping should be 0"

# Check that no assertion still equals 1
assert_not_grep 'len(conflicts).*== 1' "$TEST_FILE" \
    "POLY-BRK-P2 not fixed: at least one assertion still has wrong count == 1"

# ── 3. Run pytest — must pass ──
echo "[] Running test_broken_p2.py..." >&2
if ! run_python_tests "$PY_WORKSPACE" "tests/test_broken_p2.py" 2>&1; then
    fail "POLY-BRK-P2: test_broken_p2.py still has failing assertions"
fi

pass_ "POLY-BRK-P2: test_broken_p2.py passes, conflict counts corrected from 1,1,1 to 2,0,0"
