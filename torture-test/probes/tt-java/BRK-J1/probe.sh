#!/usr/bin/env bash
# Probe: BRK-J1 — broken test assertion (getTotalSampleDataset expects 450 instead of 475)
# Fixture: tt-java
# Task type: broken-test
#
# Checks:
#   1. getTotalSampleDataset assertion expects 475.00 (not 450.00)
#   2. Full test suite passes

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/src/test/java/com/tamandua/ledger/LedgerServiceTest.java"
check_file_exists "$TEST_FILE" "LedgerServiceTest.java not found in workspace"

# ── 1. Correct expected value in getTotalSampleDataset ──
echo "[] Checking getTotalSampleDataset expected total..." >&2

# The broken version expects 450.00; the fix expects 475.00 (100+50+75+150+25+75)
assert_not_grep '"450\.00"' "$TEST_FILE" \
    "BRK-J1 not fixed: getTotalSampleDataset still expects 450.00 (should be 475.00)"

assert_grep '"475\.00"' "$TEST_FILE" \
    "BRK-J1 not fixed: getTotalSampleDataset does not expect 475.00"

# ── 2. Full test suite passes ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" ./mvnw -q -B test 2>&1; then
    fail "BRK-J1: test suite still has failures"
fi

pass_ "BRK-J1: getTotalSampleDataset expects 475.00, full test suite passes"
