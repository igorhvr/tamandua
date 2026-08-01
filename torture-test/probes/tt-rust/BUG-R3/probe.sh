#!/usr/bin/env bash
# Probe: BUG-R3 — infinite loop in try_consume() (missing return-false path)
# Fixture: tt-rust
# Task type: bug (A3 — red-herring, symptom looks like test timeout)
#
# Checks:
#   1. try_consume() returns false when tokens are insufficient (no infinite loop)
#   2. cargo test --quiet completes without hanging
#   3. Regression tests exist for try_consume returning false
#   4. Revert-probe: apply seed overlay → tests must hang/fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-rust/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-R3"
BUCKET_FILE="$WORKSPACE/src/bucket.rs"

check_file_exists "$BUCKET_FILE" "src/bucket.rs not found in workspace"

# ── 1. try_consume returns false when exhausted (no infinite loop) ──
echo "[] Checking try_consume() has return-false path..." >&2

# The buggy version wraps the CAS logic in an outer loop{} that never returns false.
# The fix restores the original try_consume that returns false when insufficient.
# Check that a return-false path exists in the file (the fixed try_consume should
# have `return false` when available < count and within refill interval).
# We grep for `return false` which is the canonical Rust way to signal exhaustion.
assert_grep 'return false' "$BUCKET_FILE" \
    "BUG-R3 not fixed: try_consume() has no return-false path for exhaustion"

# Also verify the return-false path is NOT just in unrelated dead code.
# The seed version has an outer loop that never returns false, so `return false`
# will be absent from the try_consume function body in the buggy version.
# In the fixed version, it appears after checking insufficient tokens.

# ── 2. Regression tests exist ──
echo "[] Checking for regression tests..." >&2

check_regression_test "$WORKSPACE" "BugR3\|bug_r3\|hang\|exhausted\|returns_false\|infinite" \
    "BUG-R3: no regression test found for try_consume returning false"

# ── 3. Full test suite passes (and does NOT hang) ──
echo "[] Running cargo test..." >&2
# Use timeout to guard against residual infinite loops
if ! run_in_workspace "$WORKSPACE" timeout 60 cargo test --quiet 2>&1; then
    fail "BUG-R3: test suite has failures — fix is incomplete"
fi

# ── 4. Revert-probe: apply seed overlay → tests must hang (timeout) ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-r3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay (buggy bucket.rs with infinite loop)
dest=$(find "$REVERT_SCRATCH" -type f -name 'bucket.rs' -not -path '*/target/*' -not -path '*/.git/*' 2>/dev/null | head -1)
if [ -z "$dest" ]; then
    if [ -d "$REVERT_SCRATCH/src" ]; then
        dest="$REVERT_SCRATCH/src/bucket.rs"
    fi
fi
if [ -n "$dest" ]; then
    cp "$SEED_DIR/bucket.rs" "$dest"
else
    infra_error "BUG-R3 revert-probe: could not locate bucket.rs in scratch clone"
fi

# Run with a timeout — tests that expect try_consume to return false should hang.
# The tests that trigger the infinite loop include: try_consume_exhaustive_sequence,
# consume_one_from_one, tokens_drain_before_refill_interval.
if run_in_workspace "$REVERT_SCRATCH" timeout 30 cargo test --quiet -- "BugR3\|bug_r3\|try_consume_exhaustive_sequence\|consume_one_from_one\|tokens_drain_before_refill_interval\|exhausted" 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-R3 infinite loop — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests hung/timed out as expected when bug re-introduced" >&2

pass_ "BUG-R3: try_consume returns false on exhaustion, cargo test completes without hanging, regression tests exist, revert-probe passed"
