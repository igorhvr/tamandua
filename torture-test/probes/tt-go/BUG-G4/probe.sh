#!/usr/bin/env bash
# Probe: BUG-G4 — data race (non-atomic completed counter)
# Fixture: tt-go
# Task type: bug (A4 — data race, only detectable with -race flag)
#
# Checks:
#   1. completed field is atomic.Int64 (not plain int64)
#   2. Completed() uses .Load() (not direct field read)
#   3. Worker uses .Add(1) (not p.completed++)
#   4. go test -race ./... passes (no race detected)
#   5. Regression test exists
#   6. Revert-probe: apply seed overlay → go test -race fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G4"
POOL_FILE="$WORKSPACE/pool.go"

# ── 1. completed is atomic.Int64 ──
echo "[] Checking completed field type..." >&2
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

assert_not_grep 'completed[[:space:]]\+int64' "$POOL_FILE" \
    "BUG-G4 not fixed: completed is still plain int64 (not atomic.Int64)"

assert_grep 'completed[[:space:]]\+atomic\.Int64\|completed[[:space:]]\+int64.*atomic' "$POOL_FILE" \
    "BUG-G4 not fixed: completed field not atomic"

# ── 2. Completed() uses atomic Load ──
echo "[] Checking Completed() read..." >&2
assert_grep 'completed\.Load()' "$POOL_FILE" \
    "BUG-G4 not fixed: Completed() does not use atomic Load"

# ── 3. Worker uses atomic Add(1), not p.completed++ ──
echo "[] Checking worker counter increment..." >&2
assert_not_grep 'completed++' "$POOL_FILE" \
    "BUG-G4 not fixed: worker still uses non-atomic completed++"

assert_grep 'completed\.Add(1)' "$POOL_FILE" \
    "BUG-G4 not fixed: worker does not use atomic Add(1)"

# ── 4. go test -race passes (no race detected) ──
echo "[] Running go test -race..." >&2
if ! run_in_workspace "$WORKSPACE" go test -race -timeout 60s ./... 2>&1; then
    fail "BUG-G4: go test -race detected a data race — fix is incomplete"
fi

# ── 5. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "TestBugG4\|regressionBugG4\|NoDataRaceOnCompleted" \
    "BUG-G4: no regression test found for data-race-free completed counter"

# ── 6. go test (without -race) also passes ──
echo "[] Running go test (baseline)..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BUG-G4: standard test suite has failures"
fi

# ── 7. Revert-probe: apply seed overlay → go test -race must detect race ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay (restore buggy pool.go with non-atomic completed)
dest=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name 'pool.go' -not -path '*/vendor/*' | head -1)
if [ -n "$dest" ]; then
    cp "$SEED_DIR/pool.go" "$dest"
else
    cp "$SEED_DIR/pool.go" "$REVERT_SCRATCH/pool.go"
fi

# Run with -race — must detect a data race
if run_in_workspace "$REVERT_SCRATCH" go test -race -timeout 60s -run "TestBugG4|regressionBugG4|NoDataRace" ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: go test -race passed after re-introducing BUG-G4 data race — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: go test -race detected data race as expected" >&2

pass_ "BUG-G4: completed is atomic.Int64, Completed() uses Load(), worker uses Add(1), go test -race passes, regression test exists, revert-probe passed"
