#!/usr/bin/env bash
# Probe: BUG-G1 — off-by-one counter (Submitted increments before ctx.Done check)
# Fixture: tt-go
# Task type: bug (A1 — off-by-one, fixer must write regression test)
#
# Checks:
#   1. Submit() increments submitted counter AFTER ctx.Done() check (not before)
#   2. Regression test exists for Submitted counter matching Results count
#   3. Revert-probe: apply seed overlay → regression test must fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G1"
POOL_FILE="$WORKSPACE/pool.go"

# ── 1. Submitted counter incremented after ctx.Done() check ──
echo "[] Checking Submit() counter placement..." >&2
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

# The fix moves p.submitted.Add(1) from before the first select to inside
# the taskQueue <- task case, so rejected submits don't inflate the counter.
# After the fix, Add(1) must appear IN the send case, not before the ctx.Done select.
# We verify the fix by checking for the correct pattern: Add(1) should be after
# a "case p.taskQueue <- task:" line (within ~5 lines), not before the select.
if ! grep -A5 'case p\.taskQueue <- task:' "$POOL_FILE" | grep -q 'p\.submitted\.Add(1)'; then
    fail "BUG-G1 not fixed: submitted.Add(1) not after taskQueue send case"
fi

# ── 2. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "TestBugG1\|regressionBugG1\|SubmittedCounter" \
    "BUG-G1: no regression test found for Submitted counter accuracy"

# ── 3. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BUG-G1: test suite has failures — fix is incomplete"
fi

# ── 4. Revert-probe: apply seed overlay → regression test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay — copy buggy pool.go over the fixed one
dest=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name 'pool.go' -not -path '*/vendor/*' | head -1)
if [ -n "$dest" ]; then
    cp "$SEED_DIR/pool.go" "$dest"
else
    cp "$SEED_DIR/pool.go" "$REVERT_SCRATCH/pool.go"
fi

# Run regression test — must fail (bug re-introduced, counter mismatch)
if run_in_workspace "$REVERT_SCRATCH" go test -run "TestBugG1|regressionBugG1|SubmittedCounter" ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: regression tests passed after re-introducing BUG-G1 off-by-one — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests failed as expected when bug re-introduced" >&2

pass_ "BUG-G1: Submitted counter incremented after ctx.Done check, regression test exists, revert-probe passed"
