#!/usr/bin/env bash
# Probe: POLY-BUG-P2 — two-module bug: yearly interval + CONTAINED strict comparison
# Fixture: tt-poly-lite (python/ subtree)
# Task type: bug (A2 — two modules must both be fixed)
#
# Checks:
#   1. Yearly recurrence respects self.interval (biennial: every_two_years test)
#   2. CONTAINED check uses <=/>= for equal boundaries
#   3. Regression tests exist for both fixes
#   4. Revert-probe: apply seed overlay → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-poly-lite/python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/POLY-BUG-P2"
PY_WORKSPACE="$WORKSPACE/python"

# ── 1. Yearly recurrence respects interval ──
echo "[] Checking yearly interval behavior..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.recurrence import yearly

# every_two_years: interval=2 should give 2 outcomes in 2026-2028 window
rule = yearly(interval=2, count=3)
results = rule.occurrences(date(2026, 1, 1), date(2029, 12, 31))
print(len(results))
" 2>&1) || infra_error "failed to run yearly interval check"

biennial_count=$(echo "$output" | tail -1)
if [ "$biennial_count" -ne 3 ]; then
    fail "POLY-BUG-P2 not fixed: yearly(interval=2, count=3) produced $biennial_count occurrences (expected 3)"
fi

# ── 2. CONTAINED severity uses <=/>= ──
echo "[] Checking CONTAINED severity for equal boundaries..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import datetime, timezone
from schedlib.engine import Event
from schedlib.conflict import conflict_severity, ConflictSeverity
utc = timezone.utc

# Two events with identical start/end times — should be CONTAINED
a = Event('a', datetime(2026,8,1,9,0,tzinfo=utc), datetime(2026,8,1,10,0,tzinfo=utc))
b = Event('b', datetime(2026,8,1,9,0,tzinfo=utc), datetime(2026,8,1,10,0,tzinfo=utc))
result = conflict_severity(a, b)
print('CONTAINED' if result == ConflictSeverity.CONTAINED else 'NOT_CONTAINED')
" 2>&1) || infra_error "failed to run CONTAINED severity check"

severity_result=$(echo "$output" | tail -1)
if [ "$severity_result" != "CONTAINED" ]; then
    fail "POLY-BUG-P2 not fixed: identical boundaries should be CONTAINED, got $severity_result (strict comparison still present)"
fi

# ── 3. Source code checks for both modules ──
echo "[] Checking source code for both fixes..." >&2
RECURRENCE_FILE="$PY_WORKSPACE/src/schedlib/recurrence.py"
CONFLICT_FILE="$PY_WORKSPACE/src/schedlib/conflict.py"

# recurrence.py should use self.interval in yearly _advance
assert_not_grep '_add_years.*[^l]1[^0]' "$RECURRENCE_FILE" \
    "POLY-BUG-P2 not fixed: yearly _advance still uses hardcoded 1 year"

# conflict.py should use <=/>= in CONTAINED check
assert_grep '<=.*start\|start.*<=\|>=.*end\|end.*>=' "$CONFLICT_FILE" \
    "POLY-BUG-P2 not fixed: CONTAINED check still uses strict comparison"

# ── 4. Regression tests exist ──
check_regression_test "$WORKSPACE/python" "test_every_two_years\|test_contained_equal_bounds" \
    "no regression test found for POLY-BUG-P2 — fixer must write tests per A2 archetype"

# ── 5. Revert-probe: apply seed overlays → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-p2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

for pth_file in "$REVERT_SCRATCH"/python/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

# Apply both seed overlays
apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH/python"

# Run full pytest — should produce at least 2 failures
PYTEST_OUTPUT=$(run_in_workspace "$REVERT_SCRATCH/python" .venv/bin/python -m pytest -q 2>&1) || true
FAIL_COUNT=$(echo "$PYTEST_OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
if [ "$FAIL_COUNT" -lt 2 ]; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: expected at least 2 test failures after re-introducing POLY-BUG-P2 bugs, got $FAIL_COUNT"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: $FAIL_COUNT failures when bugs re-introduced" >&2

pass_ "POLY-BUG-P2: yearly interval respected (biennial count=$biennial_count), CONTAINED=$severity_result, regression tests exist, revert-probe passed ($FAIL_COUNT failures)"
