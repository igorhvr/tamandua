#!/usr/bin/env bash
# Probe: BRK-R1 — broken test: off-by-one expected count (4_999 vs 5_000)
# Fixture: tt-rust
# Task type: broken-test
#
# Checks:
#   1. integration_concurrent_consumers expects 5_000 (not 4_999)
#   2. cargo test --quiet exits 0 (all tests pass)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

INTEGRATION_FILE="$WORKSPACE/tests/integration.rs"

check_file_exists "$INTEGRATION_FILE" "tests/integration.rs not found in workspace"

# ── 1. Verify fix: expected count is 5_000 (not 4_999) ──
echo "[] Checking for correct expected count in integration_concurrent_consumers..." >&2

# The broken test expects 4_999 tokens consumed when 5_000 are actually consumed.
# The fix corrects the expected value to 5_000.
assert_not_grep '4_999\|4999' "$INTEGRATION_FILE" \
    "BRK-R1 not fixed: integration test still expects 4_999 tokens instead of 5_000"

# Verify the corrected assertion: should have 5_000 somewhere
assert_grep '5_000\|5000' "$INTEGRATION_FILE" \
    "BRK-R1 not fixed: expected value 5_000 not found in integration test"

# ── 2. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "BRK-R1: test suite still has failures"
fi

pass_ "BRK-R1: expected count corrected from 4_999 to 5_000, cargo test passes"
