#!/usr/bin/env bash
# Probe: BUG-P2 — two-module bug: yearly _advance + conflict_severity CONTAINED check
# Fixture: tt-python
# Task type: bug (A2 — coordinated 2-file fix required)
#
# Checks:
#   1. yearly(interval=2) is biennial (3 results in 6-year span, not 7)
#   2. conflict_severity treats equal bounds as CONTAINED (not HARD)
#   3. Both files fixed (single-file fix leaves a failure)
#   4. Revert-probe: apply seed overlay → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── Locate seeds directory ──
SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-P2"

# ── 1. yearly(interval=2) is biennial ──
echo "[] Checking yearly interval behavior..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.recurrence import yearly

# yearly(interval=2) from 2026 to 2031: should produce 2026, 2028, 2030 (3 results)
rule = yearly(interval=2)
results = rule.occurrences(date(2026, 7, 30), date(2031, 7, 30))
print(len(results))
" 2>&1) || infra_error "failed to run yearly interval check"

count=$(echo "$output" | tail -1)
if [ "$count" -ne 3 ]; then
    fail "BUG-P2 not fixed: yearly(interval=2) produced $count occurrences in 6-year span (expected 3 — biennial)"
fi

# ── 2. conflict_severity with equal bounds → CONTAINED ──
echo "[] Checking conflict_severity equal-bounds behavior..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import datetime, timezone
from schedlib.conflict import conflict_severity, ConflictSeverity
from schedlib.engine import Event

utc = timezone.utc
a = Event('A', datetime(2026,7,30,10,0,tzinfo=utc), datetime(2026,7,30,11,0,tzinfo=utc))
b = Event('B', datetime(2026,7,30,10,0,tzinfo=utc), datetime(2026,7,30,11,0,tzinfo=utc))
sev = conflict_severity(a, b)
print('CONTAINED' if sev == ConflictSeverity.CONTAINED else 'NOT_CONTAINED')
" 2>&1) || infra_error "failed to run conflict_severity check"

severity=$(echo "$output" | tail -1)
if [ "$severity" != "CONTAINED" ]; then
    fail "BUG-P2 not fixed: conflict_severity with equal bounds returned $severity (expected CONTAINED)"
fi

# ── 3. Regression test exists for both symptoms ──
check_regression_test "$WORKSPACE" "test_every_two_years\|test_contained_equal_bounds" \
    "no regression test found for yearly(interval=2) or equal-bounds CONTAINED check"

# ── 4. Full test suite passes (both fixes must be present) ──
echo "[] Running full test suite..." >&2
if ! run_python_tests "$WORKSPACE" 2>&1; then
    fail "BUG-P2: full test suite failed — both modules must be fixed together"
fi

# ── 5. Revert-probe: apply seed overlay → tests fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-p2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Fix editable install .pth to point to scratch location
for pth_file in "$REVERT_SCRATCH"/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

# Apply seed overlay (restore buggy recurrence.py and conflict.py)
apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH"

# Run full test suite — must fail
if run_in_workspace "$REVERT_SCRATCH" .venv/bin/python -m pytest -q 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-P2 bugs — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed as expected when bug re-introduced" >&2

pass_ "BUG-P2: yearly interval=$count (biennial), equal bounds=CONTAINED, full suite green, revert-probe passed"
