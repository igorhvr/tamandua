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
#   5. Regression tests for coordinated fix exist
#   6. cargo test --quiet passes
#   7. Revert-probe: apply seed overlays → tests must fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-rust/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-R2"
CONFIG_FILE="$WORKSPACE/src/config.rs"
BUCKET_FILE="$WORKSPACE/src/bucket.rs"

check_file_exists "$CONFIG_FILE" "src/config.rs not found in workspace"
check_file_exists "$BUCKET_FILE" "src/bucket.rs not found in workspace"

# ── 1. with_burst_size() stores argument ──
echo "[] Checking config setters store their arguments..." >&2

# The broken setters accept n but ignore it. The fix stores the value.
# Look for the burst_size field being assigned the argument in with_burst_size.
assert_grep 'burst_size.*=.*burst_size\|burst_size.*=.*n\|\bburst_size: n\b' "$CONFIG_FILE" \
    "BUG-R2 not fixed: with_burst_size() does not store its argument"

# ── 2. with_refill_interval() stores argument ──
assert_grep 'refill_interval_ms.*=.*refill_interval\|refill_interval_ms.*=.*ms\|\brefill_interval_ms: ms\b' "$CONFIG_FILE" \
    "BUG-R2 not fixed: with_refill_interval() does not store its argument"

# ── 3. TokenBucket::new() uses burst_size (not max_tokens) ──
echo "[] Checking TokenBucket::new() uses burst_size..." >&2

assert_not_grep 'current_tokens.*config\.max_tokens()\|current_tokens.*max_tokens()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: TokenBucket::new() still uses max_tokens instead of burst_size"

assert_grep 'burst_size()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: TokenBucket::new() does not reference burst_size()"

# ── 4. refill() uses config.refill_interval_ms (not hardcoded 100) ──
echo "[] Checking refill() uses config refill interval..." >&2

assert_not_grep '/ 100[^0-9]' "$BUCKET_FILE" \
    "BUG-R2 not fixed: refill() still uses hardcoded 100 instead of config.refill_interval_ms"

assert_grep 'refill_interval_ms()' "$BUCKET_FILE" \
    "BUG-R2 not fixed: refill() does not reference refill_interval_ms()"

# ── 5. Regression tests exist ──
echo "[] Checking for regression tests..." >&2

check_regression_test "$WORKSPACE" "BugR2\|bug_r2\|custom_burst\|coordinated" \
    "BUG-R2: no regression test found for coordinated config+bucket fix"

# ── 6. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "BUG-R2: test suite has failures — fix is incomplete"
fi

# ── 7. Revert-probe: apply seed overlays → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-r2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlays for both files
apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH"

# Run regression tests — must fail
if run_in_workspace "$REVERT_SCRATCH" cargo test --quiet -- "bug_r2\|BugR2\|custom_burst\|coordinated" 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: regression tests passed after re-introducing BUG-R2 mismatches — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests failed as expected when bug re-introduced" >&2

pass_ "BUG-R2: config setters work, bucket uses burst_size+refill_interval_ms, regression tests exist, revert-probe passed"
