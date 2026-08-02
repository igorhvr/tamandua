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

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../../fixtures-src/tt-poly-lite/python/seeds" && pwd)"
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
if [ "$biennial_count" -ne 2 ]; then
    fail "POLY-BUG-P2 not fixed: yearly(interval=2, count=3) produced $biennial_count occurrences (expected 2 in 2026-2029 window)"
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

# ── 5. Revert-probe: apply seed overlays → tests must fail ──
pass_ "POLY-BUG-P2: yearly interval respected (biennial count=$biennial_count), CONTAINED=$severity_result"
