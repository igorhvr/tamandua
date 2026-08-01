#!/usr/bin/env bash
# Probe: BRK-G2 — broken test: inverted boolean assertion (expected error but got nil)
# Fixture: tt-go
# Task type: broken-test
#
# Checks:
#   1. pool_test.go does NOT contain the inverted error condition
#   2. go test ./... exits 0 (all tests pass)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/pool_test.go"
check_file_exists "$TEST_FILE" "pool_test.go not found in workspace"

# ── 1. Verify fix: no inverted error assertion ──
echo "[] Checking for corrected error assertion..." >&2

# The broken test had: if r.Err == nil { t.Errorf("expected error but got nil") }
# The fix corrects to: if r.Err != nil { t.Errorf("expected nil error, got %v", r.Err) }
assert_not_grep 'expected error but got nil' "$TEST_FILE" \
    "BRK-G2 not fixed: inverted error assertion still present (expects error when err IS nil)"

# ── 2. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BRK-G2: test suite still has failures"
fi

pass_ "BRK-G2: inverted boolean assertion corrected, go test passes"
