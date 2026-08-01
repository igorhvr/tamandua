#!/usr/bin/env bash
# Probe: BRK-J2 — broken test string assertion (listPrintsCorrectFormat expects "groceries" instead of "food")
# Fixture: tt-java
# Task type: broken-test
#
# Checks:
#   1. listPrintsCorrectFormat expects "food" (not "groceries") as the category name
#   2. Full test suite passes

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/src/test/java/com/tamandua/ledger/CliAppTest.java"
check_file_exists "$TEST_FILE" "CliAppTest.java not found in workspace"

# ── 1. Correct expected string in listPrintsCorrectFormat ──
echo "[] Checking listPrintsCorrectFormat expected category..." >&2

# The broken version expects "groceries"; the fix expects "food"
assert_not_grep '"groceries"' "$TEST_FILE" \
    "BRK-J2 not fixed: listPrintsCorrectFormat still expects 'groceries' (should be 'food')"

assert_grep '"food"' "$TEST_FILE" \
    "BRK-J2 not fixed: listPrintsCorrectFormat does not expect 'food'"

# ── 2. Full test suite passes ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" ./mvnw -q -B test 2>&1; then
    fail "BRK-J2: test suite still has failures"
fi

pass_ "BRK-J2: listPrintsCorrectFormat expects 'food', full test suite passes"
