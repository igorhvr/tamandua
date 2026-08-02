#!/usr/bin/env bash
# Probe: VULN-R1 — unsafe pointer arithmetic in get_unchecked/set_unchecked
# Fixture: tt-rust
# Task type: vuln (dormant code path — unsafe code replaced with safe get/get_mut)
#
# Checks:
#   1. No unsafe blocks in util_unsafe.rs (replaced with safe indexing)
#   2. Safe .get() / .get_mut() is used instead
#   3. Functions return Option/Result (not raw values)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

UTIL_FILE="$WORKSPACE/src/util_unsafe.rs"

check_file_exists "$UTIL_FILE" "src/util_unsafe.rs not found in workspace"

# ── 1. No unsafe blocks ──
echo "[] Checking for removed unsafe blocks..." >&2
assert_not_grep 'unsafe\s*{' "$UTIL_FILE" \
    "VULN-R1 not fixed: unsafe blocks still present in util_unsafe.rs"

# ── 2. Safe .get() / .get_mut() used instead ──
echo "[] Checking for safe indexing methods..." >&2
assert_grep '\.get(\|\.get_mut(' "$UTIL_FILE" \
    "VULN-R1 not fixed: no safe .get() or .get_mut() call found in util_unsafe.rs"

# ── 3. Returns Option/Result (not raw i32) ──
echo "[] Checking return types..." >&2
assert_grep 'Option<\|Result<' "$UTIL_FILE" \
    "VULN-R1 not fixed: safe functions should return Option/Result, not raw types"

pass_ "VULN-R1: unsafe blocks replaced with safe get/get_mut returning Option/Result"
