#!/usr/bin/env bash
# Probe: BUG-R4 — O(n²) algorithmic regression in refill() via consume_count spin loop
# Fixture: tt-rust
# Task type: bug (A4 — performance threshold, O(n²) only detectable at scale)
#
# Checks:
#   1. refill() does NOT contain a black_box-guarded loop over consume_count
#   2. No consume_count AtomicU64 field in TokenBucket (removed)
#   3. refill() is O(1) — only tracks last_refill timestamp + token counter
#   4. Regression tests for O(1) refill performance exist
#   5. cargo test --quiet passes
#   6. Revert-probe: apply seed overlay → performance test must fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-rust/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-R4"
BUCKET_FILE="$WORKSPACE/src/bucket.rs"

check_file_exists "$BUCKET_FILE" "src/bucket.rs not found in workspace"

# ── 1. No consume_count field ──
echo "[] Checking consume_count is removed..." >&2

assert_not_grep 'consume_count' "$BUCKET_FILE" \
    "BUG-R4 not fixed: consume_count still present in TokenBucket"

# ── 2. No black_box spin loop in refill ──
echo "[] Checking refill() is O(1)..." >&2

assert_not_grep 'black_box' "$BUCKET_FILE" \
    "BUG-R4 not fixed: black_box still present in bucket.rs (O(n²) refill loop)"

# ── 3. refill() uses O(1) timestamp-based tracking ──
echo "[] Checking refill() uses O(1) timestamp tracking..." >&2

# The O(1) fix tracks last_refill timestamp and computes tokens based on elapsed time.
# Look for the standard O(1) pattern: elapsed = now - last_refill / refill_interval.
assert_grep 'last_refill\|elapsed' "$BUCKET_FILE" \
    "BUG-R4 not fixed: refill() does not use timestamp-based O(1) tracking"

# ── 4. Regression tests exist ──
echo "[] Checking for regression tests..." >&2

check_regression_test "$WORKSPACE" "BugR4\|bug_r4\|performance\|ten_thousand\|10k\|O.n.2\|throughput" \
    "BUG-R4: no regression test found for O(1) refill performance"

# ── 5. Full test suite passes ──
echo "[] Running cargo test..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "BUG-R4: test suite has failures — fix is incomplete"
fi

# ── 6. Revert-probe: apply seed overlay → performance test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-r4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay (buggy bucket.rs with O(n²) refill)
dest=$(find "$REVERT_SCRATCH" -type f -name 'bucket.rs' -not -path '*/target/*' -not -path '*/.git/*' 2>/dev/null | head -1)
if [ -z "$dest" ]; then
    if [ -d "$REVERT_SCRATCH/src" ]; then
        dest="$REVERT_SCRATCH/src/bucket.rs"
    fi
fi
if [ -n "$dest" ]; then
    cp "$SEED_DIR/bucket.rs" "$dest"
else
    infra_error "BUG-R4 revert-probe: could not locate bucket.rs in scratch clone"
fi

# Run performance regression tests — must fail
if run_in_workspace "$REVERT_SCRATCH" cargo test --quiet -- "BugR4\|bug_r4\|performance\|ten_thousand\|10k\|throughput\|perf" 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: performance tests passed after re-introducing BUG-R4 O(n²) refill — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: performance tests failed as expected when bug re-introduced" >&2

pass_ "BUG-R4: consume_count removed, black_box loop gone, O(1) refill, regression tests exist, revert-probe passed"
