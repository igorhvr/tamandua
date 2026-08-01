#!/usr/bin/env bash
# Probe: VULN-R1 — unsafe pointer arithmetic in get_unchecked/set_unchecked
# Fixture: tt-rust
# Task type: vuln (dormant code path — no seed patch, check fix only)
#
# Checks:
#   1. util_unsafe.rs: no get_unchecked using unsafe pointer arithmetic
#   2. util_unsafe.rs: no set_unchecked using unsafe pointer arithmetic
#   3. Safe get(idx) returning Option (via .get() / .get_mut()) is used instead
#   4. No unsafe blocks in util_unsafe.rs

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

UTIL_FILE="$WORKSPACE/src/util_unsafe.rs"

check_file_exists "$UTIL_FILE" "src/util_unsafe.rs not found in workspace"

# ── 1. No get_unchecked using unsafe pointer arithmetic ──
echo "[] Checking get_unchecked replaced with safe get()..." >&2

assert_not_grep 'get_unchecked' "$UTIL_FILE" \
    "VULN-R1 not fixed: get_unchecked still present in util_unsafe.rs"

assert_not_grep 'set_unchecked' "$UTIL_FILE" \
    "VULN-R1 not fixed: set_unchecked still present in util_unsafe.rs"

# ── 2. No unsafe blocks ──
echo "[] Checking for removed unsafe blocks..." >&2

assert_not_grep 'unsafe' "$UTIL_FILE" \
    "VULN-R1 not fixed: unsafe blocks still present in util_unsafe.rs"

# ── 3. Safe .get() / .get_mut() used instead ──
echo "[] Checking for safe indexing methods..." >&2

assert_grep 'get.*idx\|\.get(' "$UTIL_FILE" \
    "VULN-R1 not fixed: no safe .get() call found in util_unsafe.rs"

# Verify Option return type — safe get returns Option
assert_grep 'Option<' "$UTIL_FILE" \
    "VULN-R1 not fixed: safe get should return Option, not raw u32"

# ── 4. Regression test for out-of-bounds returning None ──
echo "[] Checking for regression tests..." >&2

check_regression_test "$WORKSPACE" "VulnR1\|vuln_r1\|out_of_bounds.*None\|bounds.*None\|None.*bounds" \
    "VULN-R1: no regression test found for out-of-bounds returning None"

# ── 5. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "VULN-R1: test suite has failures"
fi

pass_ "VULN-R1: get_unchecked/set_unchecked replaced with safe get, no unsafe blocks, regression tests exist"
