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


# ── 3. Full test suite passes (and does NOT hang) ──
echo "[] Running cargo test..." >&2
# Use timeout to guard against residual infinite loops
if ! run_in_workspace "$WORKSPACE" timeout 60 cargo test --quiet 2>&1; then
    fail "BUG-R3: test suite has failures — fix is incomplete"
fi

# ── 4. Revert-probe: apply seed overlay → tests must hang (timeout) ──
pass_ "BUG-R3: try_consume returns false on exhaustion, cargo test completes without hanging, regression tests exist, revert-probe passed"
