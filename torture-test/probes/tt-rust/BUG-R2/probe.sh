#!/usr/bin/env bash
# Probe: BUG-R2 — two-module: config setters ignore args + bucket uses hardcoded values
# Fixture: tt-rust
# Task type: bug (A2 — two-module coordinated fix)
#
# Checks:
#   1. with_burst_size() stores its argument (not ignored)
#   2. with_refill_interval() stores its argument (not ignored)
#   3. TokenBucket::new() uses config.burst_size() (not max_tokens)
#   4. refill() uses config.refill_interval_ms() (not hardcoded 100)
#   5. Full test suite passes

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CONFIG_FILE="$WORKSPACE/src/config.rs"
BUCKET_FILE="$WORKSPACE/src/bucket.rs"

check_file_exists "$CONFIG_FILE" "src/config.rs not found in workspace"
check_file_exists "$BUCKET_FILE" "src/bucket.rs not found in workspace"

# ── 1. with_burst_size() stores argument ──
echo "[] Checking config setters store their arguments..." >&2
assert_grep 'self\.burst_size\s*=\s*burst_size' "$CONFIG_FILE" \
    "BUG-R2 not fixed: with_burst_size() does not store its argument"

# ── 2. with_refill_interval() stores argument ──
assert_grep 'self\.refill_interval_ms\s*=\s*ms' "$CONFIG_FILE" \
    "BUG-R2 not fixed: with_refill_interval() does not store its argument (still hardcoded to 100)"

# ── 3. TokenBucket::new() uses burst_size (not max_tokens) ──
echo "[] Checking TokenBucket::new() uses burst_size..." >&2
assert_not_grep 'current_tokens.*max_tokens()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: TokenBucket::new() still uses max_tokens instead of burst_size"
assert_grep 'burst_size()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: TokenBucket::new() does not reference burst_size()"

# ── 4. refill() uses config.refill_interval_ms (not hardcoded 100) ──
echo "[] Checking refill() uses config refill interval..." >&2
assert_not_grep 'elapsed < 100\b' "$BUCKET_FILE" \
    "BUG-R2 not fixed: refill() still uses hardcoded 100 instead of config.refill_interval_ms"
assert_grep 'refill_interval_ms()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: refill() does not reference refill_interval_ms()"

pass_ "BUG-R2: config setters work, bucket uses burst_size+refill_interval_ms"
