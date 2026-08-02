#!/usr/bin/env bash
# Probe: POLY-BUG-P3 — red-herring: is_weekday() treats Saturday as weekday
# Fixture: tt-poly-lite (python/ subtree)
# Task type: bug (A3 — symptom points to calendar_helpers, root cause in dates.py)
#
# Checks:
#   1. is_weekday(Saturday) returns False (buggy code returns True)
#   2. is_weekend(Saturday) returns True
#   3. Source code check: is_weekday uses < 5, not <= 5

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"

# ── 1. is_weekday(Saturday) returns False ──
echo "[] Checking is_weekday for Saturday..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.dates import is_weekday

# Saturday 2026-08-01
result = is_weekday(date(2026, 8, 1))
print('WEEKDAY' if result else 'NOT_WEEKDAY')
" 2>&1) || infra_error "failed to run is_weekday check"

weekday_result=$(echo "$output" | tail -1)
if [ "$weekday_result" = "WEEKDAY" ]; then
    fail "POLY-BUG-P3 not fixed: is_weekday returns True for Saturday (weekday 5)"
fi

# ── 2. is_weekend(Saturday) returns True ──
echo "[] Checking is_weekend for Saturday..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.dates import is_weekend

# Saturday 2026-08-01
result = is_weekend(date(2026, 8, 1))
print('WEEKEND' if result else 'NOT_WEEKEND')
" 2>&1) || infra_error "failed to run is_weekend check"

weekend_result=$(echo "$output" | tail -1)
if [ "$weekend_result" != "WEEKEND" ]; then
    fail "POLY-BUG-P3 not fixed: is_weekend returns False for Saturday"
fi

# ── 3. Source code check: is_weekday uses < 5, not <= 5 ──
echo "[] Checking is_weekday implementation..." >&2
DATES_FILE="$PY_WORKSPACE/src/schedlib/dates.py"
assert_not_grep 'weekday().*<=\s*5' "$DATES_FILE" \
    "POLY-BUG-P3 not fixed: is_weekday still uses <= 5 (Saturday as weekday)"
assert_grep 'weekday()\s*<\s*5' "$DATES_FILE" \
    "POLY-BUG-P3 not fixed: is_weekday does not use < 5"

pass_ "POLY-BUG-P3: is_weekday(Saturday)=$weekday_result, is_weekend(Saturday)=$weekend_result"
