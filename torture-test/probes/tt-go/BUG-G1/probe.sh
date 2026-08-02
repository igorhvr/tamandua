#!/usr/bin/env bash
# Probe: BUG-G1 — off-by-one counter (Submitted increments before ctx.Done check)
# Fixture: tt-go
# Task type: bug (A1 — off-by-one)
#
# Checks:
#   1. No BUG-G1 comment in pool.go (the off-by-one description)
#   2. No Submitted() method on WorkerPool
#   3. Full test suite passes
#   4. Revert-probe: apply seed overlay → probe must detect the regression

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G1"
POOL_FILE="$WORKSPACE/pool.go"

# ── 1. No BUG-G1 comment ──
echo "[] Checking BUG-G1 comment is removed..." >&2
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

assert_not_grep 'BUG-G1.*submitted counter' "$POOL_FILE" \
    "BUG-G1 not fixed: BUG-G1 off-by-one still present"

# ── 2. Submitted() method is removed ──
echo "[] Checking Submitted() method removal..." >&2
assert_not_grep 'Submitted()' "$POOL_FILE" \
    "BUG-G1 not fixed: Submitted() method still present"

# ── 3. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BUG-G1: test suite has failures — fix is incomplete"
fi

# ── 4. Revert-probe: apply seed overlay → regression must be detectable ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Apply seed overlay
for f in "$SEED_DIR"/*.go; do
    bn=$(basename "$f")
    dest=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name "$bn" -not -path '*/vendor/*' | head -1)
    if [ -n "$dest" ]; then
        cp "$f" "$dest"
    else
        cp "$f" "$REVERT_SCRATCH/"
    fi
done

# After revert, the BUG code must be present again
rpool=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name 'pool.go' -not -path '*/vendor/*' | head -1)
if [ -z "$rpool" ] || ! grep -q 'BUG-G1.*submitted counter' "$rpool"; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: BUG-G1 not detectable after re-introducing seed"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: BUG-G1 re-introduced and detectable" >&2

pass_ "BUG-G1: BUG-G1 removed, Submitted() removed, tests pass, revert-probe passed"
