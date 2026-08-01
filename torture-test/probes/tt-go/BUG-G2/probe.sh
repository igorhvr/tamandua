#!/usr/bin/env bash
# Probe: BUG-G2 — two-module error propagation (Shutdown error wrapping + worker check)
# Fixture: tt-go
# Task type: bug (A2 — two-module coordinated fix)
#
# Checks:
#   1. Shutdown() uses ErrPoolShutdown directly (not fmt.Errorf wrapping)
#   2. Worker sends results unconditionally (no errors.Is check on shutdownErr)
#   3. ShutdownErr() returns ErrPoolShutdown (not a wrapped error)
#   4. Regression test exists
#   5. Revert-probe: apply seed overlays → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G2"
POOL_FILE="$WORKSPACE/pool.go"
WORKER_FILE="$WORKSPACE/worker.go"

# ── 1. Shutdown uses ErrPoolShutdown directly (no fmt.Errorf wrapping) ──
echo "[] Checking Shutdown error assignment..." >&2
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

assert_grep 'p\.shutdownErr = ErrPoolShutdown' "$POOL_FILE" \
    "BUG-G2 not fixed: Shutdown does not assign ErrPoolShutdown directly"

assert_not_grep 'fmt\.Errorf.*shutdown' "$POOL_FILE" \
    "BUG-G2 not fixed: Shutdown still uses fmt.Errorf wrapping for shutdownErr"

# ── 2. Worker sends results unconditionally (no errors.Is guard) ──
echo "[] Checking worker result delivery..." >&2
check_file_exists "$WORKER_FILE" "worker.go not found in workspace"

assert_not_grep 'errors\.Is.*ErrPoolShutdown\|errors\.Is.*shutdownErr' "$WORKER_FILE" \
    "BUG-G2 not fixed: worker still has errors.Is shutdown check that drops results"

# ── 3. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "TestBugG2\|regressionBugG2\|ShutdownResultsNotDropped" \
    "BUG-G2: no regression test found for shutdown results not being dropped"

# ── 4. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BUG-G2: test suite has failures — fix is incomplete"
fi

# ── 5. Revert-probe: apply seed overlays → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlays (restore buggy pool.go and worker.go)
for f in "$SEED_DIR"/*.go; do
    bn=$(basename "$f")
    dest=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name "$bn" -not -path '*/vendor/*' | head -1)
    if [ -n "$dest" ]; then
        cp "$f" "$dest"
    else
        cp "$f" "$REVERT_SCRATCH/"
    fi
done

# Run regression test — must fail
if run_in_workspace "$REVERT_SCRATCH" go test -run "TestBugG2|regressionBugG2|ShutdownResults" ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: regression tests passed after re-introducing BUG-G2 — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests failed as expected" >&2

pass_ "BUG-G2: ErrPoolShutdown assigned directly, worker delivers results unconditionally, regression test exists, revert-probe passed"
