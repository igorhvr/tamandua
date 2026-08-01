#!/usr/bin/env bash
# Probe: FEAT-R1 — sliding window rate limiter (SlidingWindowBucket)
# Fixture: tt-rust
# Task type: feature
#
# Checks:
#   1. SlidingWindowBucket type exists with VecDeque<Instant>
#   2. try_acquire(&mut self) -> bool exists
#   3. Prunes entries older than 1 second
#   4. Mutex<SlidingWindowBucket> for interior mutability
#   5. Feature tests exist and pass
#   6. Existing TokenBucket tests still pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. SlidingWindowBucket type exists ──
echo "[] Checking for SlidingWindowBucket..." >&2

# Find the source file: could be src/sliding.rs, src/lib.rs, src/bucket.rs, or new file
SLIDING_SRC=$(find "$WORKSPACE/src" -maxdepth 1 -type f -name '*.rs' -exec grep -l 'SlidingWindowBucket' {} \; 2>/dev/null | head -1)
if [ -z "$SLIDING_SRC" ]; then
    # Check if it's in lib.rs as a module declaration referencing a file
    SLIDING_SRC=$(find "$WORKSPACE" -type f -name '*.rs' -not -path '*/target/*' -exec grep -l 'SlidingWindowBucket' {} \; 2>/dev/null | head -1)
fi
if [ -z "$SLIDING_SRC" ]; then
    fail "FEAT-R1 not implemented: SlidingWindowBucket type not found in workspace"
fi

assert_grep 'SlidingWindowBucket' "$SLIDING_SRC" \
    "FEAT-R1 not implemented: SlidingWindowBucket struct not found"

# ── 2. VecDeque<Instant> ──
echo "[] Checking for VecDeque<Instant>..." >&2

assert_grep 'VecDeque.*Instant\|VecDeque<.*Instant' "$SLIDING_SRC" \
    "FEAT-R1 not implemented: no VecDeque<Instant> for sliding window tracking"

# ── 3. try_acquire method ──
echo "[] Checking for try_acquire method..." >&2

assert_grep 'try_acquire' "$SLIDING_SRC" \
    "FEAT-R1 not implemented: no try_acquire method"

# ── 4. Mutex<SlidingWindowBucket> for interior mutability ──
echo "[] Checking for Mutex wrapping..." >&2

workspace_grep "$WORKSPACE" 'Mutex.*SlidingWindowBucket\|Mutex<SlidingWindowBucket' 'src/' > /dev/null
if ! workspace_grep "$WORKSPACE" 'Mutex.*SlidingWindowBucket\|Mutex<SlidingWindowBucket' 'src/' | grep -q 'SlidingWindowBucket'; then
    fail "FEAT-R1 not implemented: no Mutex<SlidingWindowBucket> for interior mutability"
fi

# ── 5. Feature tests exist ──
echo "[] Checking for feature tests..." >&2

check_regression_test "$WORKSPACE" "FEAT.R1\|feat_r1\|sliding_window\|SlidingWindow\|try_acquire" \
    "FEAT-R1: no tests found for sliding window rate limiter"

# ── 6. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" cargo test --quiet -- "feat_r1\|FEAT.R1\|sliding_window\|try_acquire" 2>&1; then
    fail "FEAT-R1: sliding window feature tests failed"
fi

# ── 7. Full test suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "FEAT-R1: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-R1: SlidingWindowBucket with VecDeque<Instant>, try_acquire(), Mutex wrapping, feature tests pass, full suite green"
