#!/usr/bin/env bash
# Probe: BRK-R2 — broken test: inverted boolean assertion (try_consume(4) is true vs false)
# Fixture: tt-rust
# Task type: broken-test
#
# Checks:
#   1. integration_try_consume_fails_when_insufficient uses !try_consume(4) (not try_consume(4))
#   2. cargo test --quiet exits 0 (all tests pass)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

INTEGRATION_FILE="$WORKSPACE/tests/integration.rs"

check_file_exists "$INTEGRATION_FILE" "tests/integration.rs not found in workspace"

# ── 1. Verify fix: inverted boolean assertion is corrected ──
echo "[] Checking for corrected boolean assertion in integration_try_consume_fails_when_insufficient..." >&2

# The broken test has: assert!(bucket.try_consume(4))
# The fix should be: assert!(!bucket.try_consume(4))
# The probe verifies the negation is present.
assert_grep '!.*try_consume\|try_consume.*is_false\|assert!(!try_consume' "$INTEGRATION_FILE" \
    "BRK-R2 not fixed: boolean assertion not corrected — try_consume(4) should expect false"

# ── 2. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "BRK-R2: test suite still has failures"
fi

pass_ "BRK-R2: inverted boolean assertion corrected to !try_consume(4), cargo test passes"
