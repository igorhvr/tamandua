#!/usr/bin/env bash
# Probe: BUG-R1 — integer overflow in refill() via u32 arithmetic
# Fixture: tt-rust
# Task type: bug (A1 — off-by-one/overflow, fixer must write regression test)
#
# Checks:
#   1. refill() uses u64 intermediate for elapsed * refill_rate calculation
#   2. refill() clamps to u32::MAX via .min(u32::MAX as u64)
#   3. Regression test for large refill values exists
#   4. cargo test --quiet passes
#   5. Revert-probe: apply seed overlay → regression test must fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-rust/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-R1"
BUCKET_FILE="$WORKSPACE/src/bucket.rs"

check_file_exists "$BUCKET_FILE" "src/bucket.rs not found in workspace"

# ── 1. refill() avoids u32 overflow with u64 intermediate ──
echo "[] Checking refill() overflow fix..." >&2

# The fix uses u64 for the intermediate multiplication before clamping.
# Look for patterns: (elapsed as u64) * (refill_rate as u64) or similar u64 cast,
# followed by .min(u32::MAX as u64) or similar clamp.
assert_grep 'u64.*elapsed\|elapsed.*u64' "$BUCKET_FILE" \
    "BUG-R1 not fixed: refill() does not cast elapsed to u64 for overflow-safe arithmetic"

assert_grep 'min(u32::MAX\|min(std::u32::MAX' "$BUCKET_FILE" \
    "BUG-R1 not fixed: refill() does not clamp to u32::MAX after u64 multiplication"

# ── 2. Regression test exists ──
echo "[] Checking for regression test..." >&2

# BUG-R1 is A1 — no existing test catches the overflow; fixer must write one.
# The regression test should exercise large refill values (>4,000s elapsed).
check_regression_test "$WORKSPACE" "BugR1\|bug_r1\|overflow.*refill\|refill.*overflow\|large.*refill\|large.*elapsed" \
    "BUG-R1: no regression test found for overflow-safe refill"

# ── 3. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "BUG-R1: test suite has failures — fix is incomplete"
fi

# ── 4. Revert-probe: apply seed overlay → regression test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-r1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay — copy buggy bucket.rs (u32 overflow)
dest=$(find "$REVERT_SCRATCH" -type f -name 'bucket.rs' -not -path '*/target/*' -not -path '*/.git/*' 2>/dev/null | head -1)
if [ -z "$dest" ]; then
    # bucket.rs might be in src/
    if [ -d "$REVERT_SCRATCH/src" ]; then
        dest="$REVERT_SCRATCH/src/bucket.rs"
    fi
fi
if [ -n "$dest" ]; then
    cp "$SEED_DIR/bucket.rs" "$dest"
else
    infra_error "BUG-R1 revert-probe: could not locate bucket.rs in scratch clone"
fi

# Run regression test — must fail (bug re-introduced: overflow or wrong token count)
if run_in_workspace "$REVERT_SCRATCH" cargo test --quiet -- "bug_r1\|BugR1\|overflow\|large.*refill\|large.*elapsed\|overflow_safe" 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: regression tests passed after re-introducing BUG-R1 overflow — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests failed as expected when bug re-introduced" >&2

pass_ "BUG-R1: u64 intermediate in refill(), clamped to u32::MAX, regression test exists, revert-probe passed"
