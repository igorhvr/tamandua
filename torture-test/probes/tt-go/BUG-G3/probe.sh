#!/usr/bin/env bash
# Probe: BUG-G3 — goroutine leak (worker exits on ctx.Done without draining taskQueue)
# Fixture: tt-go
# Task type: bug (A3 — red-herring: symptom looks like test timeout)
#
# Checks:
#   1. Full test suite passes with timeout (go test -timeout 30s)
#   2. Revert-probe: apply seed overlays → test hangs or fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G3"

# ── 1. Full test suite passes (with timeout guard) ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test -timeout 30s ./... 2>&1; then
    fail "BUG-G3: test suite has failures or hangs"
fi

# ── 2. Revert-probe: apply seed overlays → test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Re-introduce buggy pool.go and worker.go
for f in "$SEED_DIR"/*.go; do
    bn=$(basename "$f")
    dest=$(find "$REVERT_SCRATCH" -maxdepth 2 -type f -name "$bn" -not -path '*/vendor/*' | head -1)
    if [ -n "$dest" ]; then
        cp "$f" "$dest"
    else
        cp "$f" "$REVERT_SCRATCH/"
    fi
done

# Run with timeout — must fail or hang
if run_in_workspace "$REVERT_SCRATCH" go test -timeout 15s ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-G3 goroutine leak — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed/timed out as expected" >&2

pass_ "BUG-G3: tests pass with timeout, revert-probe passed"
