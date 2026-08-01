#!/usr/bin/env bash
# Probe: BUG-G3 — goroutine leak (worker exits on ctx.Done without draining taskQueue)
# Fixture: tt-go
# Task type: bug (A3 — red-herring: symptom looks like test timeout)
#
# Checks:
#   1. Worker drains taskQueue before exiting on ctx.Done()
#   2. Regression test exists
#   3. Revert-probe: apply seed overlay → test hangs or fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G3"
WORKER_FILE="$WORKSPACE/worker.go"

# ── 1. Worker drains task queue before exiting on ctx.Done ──
echo "[] Checking worker drain-before-exit logic..." >&2
check_file_exists "$WORKER_FILE" "worker.go not found in workspace"

# The fix adds a drain loop inside the ctx.Done() case.
# Pattern: case <-p.ctx.Done(): ... drain loop with for/select
assert_grep 'ctx\.Done' "$WORKER_FILE" \
    "BUG-G3 not fixed: no ctx.Done() handling in worker.go"

# The drain loop must include reading from taskQueue (not just a bare return)
if ! grep -A30 'case <-p\.ctx\.Done' "$WORKER_FILE" | grep -q 'taskQueue\|task_queue'; then
    fail "BUG-G3 not fixed: worker exits on ctx.Done() without draining task queue"
fi

# ── 2. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "TestBugG3\|regressionBugG3\|ShutdownDrainsAllTasks" \
    "BUG-G3: no regression test found for shutdown draining all tasks"

# ── 3. Full test suite passes (with timeout guard) ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test -timeout 30s ./... 2>&1; then
    fail "BUG-G3: test suite has failures or hangs"
fi

# ── 4. Revert-probe: apply seed overlay → regression test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g3"
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

# Run regression test with timeout — must fail or hang
if run_in_workspace "$REVERT_SCRATCH" go test -timeout 15s -run "TestBugG3|regressionBugG3|ShutdownDrains" ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: regression tests passed after re-introducing BUG-G3 goroutine leak — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests failed/timed out as expected" >&2

pass_ "BUG-G3: worker drains task queue before exit, regression test exists, revert-probe passed"
