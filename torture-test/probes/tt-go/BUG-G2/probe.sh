#!/usr/bin/env bash
# Probe: BUG-G2 — two-module error propagation (Shutdown error wrapping + worker check)
# Fixture: tt-go
# Task type: bug (A2 — two-module coordinated fix)
#
# Checks:
#   1. Full test suite passes (go test)
#   2. Revert-probe: apply seed overlays → tests must fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-go/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-G2"

# ── 1. Full test suite passes ──
echo "[] Running go test..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "BUG-G2: test suite has failures — fix is incomplete"
fi

# ── 2. Revert-probe: apply seed overlays → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-g2"
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

# Run tests — must fail
if run_in_workspace "$REVERT_SCRATCH" go test ./... 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-G2 — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed as expected" >&2

pass_ "BUG-G2: tests pass, revert-probe passed"
