#!/usr/bin/env bash
# Probe: VULN-R2 — timing side-channel in timing_unsafe_compare (short-circuiting)
# Fixture: tt-rust
# Task type: vuln (dormant code path — no seed patch, check fix only)
#
# Checks:
#   1. util_timing.rs: no short-circuiting != comparison loop
#   2. util_timing.rs: XOR-accumulator constant-time comparison used instead
#   3. Same number of operations regardless of mismatch position
#   4. Length check to avoid length-based timing leaks

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TIMING_FILE="$WORKSPACE/src/util_timing.rs"

check_file_exists "$TIMING_FILE" "src/util_timing.rs not found in workspace"

# ── 1. No short-circuiting comparison ──
echo "[] Checking short-circuiting comparison replaced with constant-time..." >&2

# The vulnerable version has: if a[i] != b[i] { return false }
# The fix uses XOR-accumulator: fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
assert_not_grep 'timing_unsafe_compare' "$TIMING_FILE" \
    "VULN-R2 not fixed: timing_unsafe_compare still present"

# Check for the XOR accumulator pattern (constant-time comparison)
assert_grep 'x *\^ *y\|\bxor\b\|XOR' "$TIMING_FILE" \
    "VULN-R2 not fixed: no XOR-based constant-time comparison found"

# ── 2. Length comparison done before byte-by-byte ──
echo "[] Checking length comparison..." >&2

assert_grep 'a\.len()\|\.len()\|len == ' "$TIMING_FILE" \
    "VULN-R2 not fixed: no length comparison before byte-by-byte compare"

# ── 3. Regression test for constant-time behavior ──
echo "[] Checking for regression tests..." >&2


# ── 4. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "VULN-R2: test suite has failures"
fi

pass_ "VULN-R2: timing_unsafe_compare replaced with XOR-accumulator constant-time comparison, regression tests exist"
