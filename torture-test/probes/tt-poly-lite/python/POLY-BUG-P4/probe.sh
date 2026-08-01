#!/usr/bin/env bash
# Probe: POLY-BUG-P4 — performance bug: O(n²) find_available_slots
# Fixture: tt-poly-lite (python/ subtree)
# Task type: bug (A4 — performance, O(n²) nested-loop vs O(n log n) sort+single-pass)
#
# Checks:
#   1. find_available_slots completes 10k events under 2s
#   2. No O(n²) nested-loop merge in source (no while changed nested for loops)
#   3. _coalesce_intervals helper exists (evidence of correct implementation)
#   4. Regression test exists
#   5. Revert-probe: apply seed overlay → perf threshold test fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-poly-lite/python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/POLY-BUG-P4"
PY_WORKSPACE="$WORKSPACE/python"

# ── 1. Performance: 10k events under 2s ──
echo "[] Checking find_available_slots performance..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
import time
from datetime import datetime, timedelta, timezone
from schedlib.engine import Event
from schedlib.conflict import find_available_slots

utc = timezone.utc
# Generate 10k tightly-packed events
events = []
base = datetime(2026, 1, 1, 0, 0, tzinfo=utc)
for i in range(10000):
    start = base + timedelta(minutes=i)
    events.append(Event(f'ev{i}', start, start + timedelta(minutes=1)))

t0 = time.perf_counter()
slots = find_available_slots(events, timedelta(minutes=5), base, base + timedelta(days=7))
elapsed = time.perf_counter() - t0

print(f'{elapsed:.3f}')
print(f'slots={len(slots)}')
" 2>&1) || infra_error "failed to run performance check"

elapsed=$(echo "$output" | grep -E '^[0-9]+\.[0-9]+$' | tail -1)
if [ -z "$elapsed" ]; then
    elapsed=$(echo "$output" | head -1)
fi

# Must complete under 2 seconds
perf_result=$(echo "$elapsed" | awk '{if ($1 > 2.0) print "TOO_SLOW"; else print "OK"}')
if [ "$perf_result" = "TOO_SLOW" ]; then
    fail "POLY-BUG-P4 not fixed: find_available_slots for 10k events took ${elapsed}s (> 2s threshold — O(n²) bug still present)"
fi

echo "[] Performance: ${elapsed}s for 10k events (threshold: 2.0s)" >&2

# ── 2. No O(n²) nested-loop merge in source ──
echo "[] Checking for absence of O(n²) nested-loop merge..." >&2
CONFLICT_FILE="$PY_WORKSPACE/src/schedlib/conflict.py"

# The buggy version has a while changed: loop with nested for i in range(len(busy)): for j in range(i+1, len(busy)):
assert_not_grep 'while changed:' "$CONFLICT_FILE" \
    "POLY-BUG-P4 not fixed: O(n²) nested-loop merge still present in conflict.py"

# ── 3. _coalesce_intervals helper exists ──
echo "[] Checking for O(n log n) coalesce helper..." >&2
assert_grep '_coalesce_intervals\|coalesce_intervals' "$CONFLICT_FILE" \
    "POLY-BUG-P4 not fixed: no _coalesce_intervals helper found (O(n log n) implementation missing)"

# ── 4. Regression test exists ──
check_regression_test "$WORKSPACE/python" "perf\|performance\|find_available_slots.*10000\|10.*000\|large.*event\|threshold" \
    "no regression test found for POLY-BUG-P4 — fixer must write one per A4 archetype"

# ── 5. Revert-probe: apply seed overlay → performance test fails ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-p4"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

for pth_file in "$REVERT_SCRATCH"/python/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH/python"

# Run pytest — must fail due to performance threshold
if run_in_workspace "$REVERT_SCRATCH/python" .venv/bin/python -m pytest -q 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-P4 O(n²) bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed as expected when O(n²) bug re-introduced" >&2

pass_ "POLY-BUG-P4: find_available_slots O(n log n) ($elapsed s for 10k), regression test exists, revert-probe passed"
