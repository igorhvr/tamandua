#!/usr/bin/env bash
# Probe: POLY-BUG-P3 — red-herring: is_weekday() treats Saturday as weekday
# Fixture: tt-poly-lite (python/ subtree)
# Task type: bug (A3 — symptom points to calendar_helpers, root cause in dates.py)
#
# Checks:
#   1. is_weekday(Saturday) returns False
#   2. is_business_day(Saturday) returns False
#   3. Regression test exists
#   4. Revert-probe: apply seed overlay → 3 test failures in calendar_helpers

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-poly-lite/python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/POLY-BUG-P3"
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

# ── 2. is_business_day(Saturday) returns False ──
echo "[] Checking is_business_day for Saturday..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.calendar_helpers import is_business_day

# Saturday 2026-08-01
result = is_business_day(date(2026, 8, 1))
print('BUSINESS_DAY' if result else 'NOT_BUSINESS_DAY')
" 2>&1) || infra_error "failed to run is_business_day check"

biz_result=$(echo "$output" | tail -1)
if [ "$biz_result" = "BUSINESS_DAY" ]; then
    fail "POLY-BUG-P3 not fixed: is_business_day returns True for Saturday"
fi

# ── 3. Source code check: is_weekday uses < 5, not <= 5 ──
echo "[] Checking is_weekday implementation..." >&2
DATES_FILE="$PY_WORKSPACE/src/schedlib/dates.py"
assert_grep 'weekday()\s*<\s*5' "$DATES_FILE" \
    "POLY-BUG-P3 not fixed: is_weekday still uses <= 5 (Saturday as weekday)"

# ── 4. Regression test exists ──
check_regression_test "$WORKSPACE/python" "is_business_day_weekend\|test_is_business_day\|test_next_business_day\|test_previous_business_day\|is_weekday.*[Ss]aturday" \
    "no regression test found for POLY-BUG-P3 — fixer must write one per A3 archetype"

# ── 5. Revert-probe: apply seed overlay → 3 failures ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-p3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

for pth_file in "$REVERT_SCRATCH"/python/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH/python"

PYTEST_OUTPUT=$(run_in_workspace "$REVERT_SCRATCH/python" .venv/bin/python -m pytest -q 2>&1) || true
FAIL_COUNT=$(echo "$PYTEST_OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
if [ "$FAIL_COUNT" -lt 3 ]; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: expected at least 3 test failures after re-introducing POLY-BUG-P3 bug, got $FAIL_COUNT"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: $FAIL_COUNT failures when bug re-introduced" >&2

pass_ "POLY-BUG-P3: is_weekday(Saturday)=$weekday_result, is_business_day(Saturday)=$biz_result, regression test exists, revert-probe passed ($FAIL_COUNT failures)"
