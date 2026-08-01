#!/usr/bin/env bash
# Probe: BUG-P3 — red-herring: is_weekday off-by-one in dates.py
# Fixture: tt-python
# Task type: bug (A3 — symptom points to calendar_helpers.py, root in dates.py)
#
# Checks:
#   1. is_weekday(Saturday) returns False
#   2. is_business_day returns False for Saturday
#   3. next_business_day / previous_business_day work correctly around weekends
#   4. Root cause is fixed in dates.py (not just papered over in calendar_helpers.py)
#   5. Revert-probe: apply seed overlay → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── Locate seeds directory ──
SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-P3"

# ── 1. is_weekday(Saturday) → False ──
echo "[] Checking is_weekday for Saturday..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.dates import is_weekday

# 2026-07-25 is a Saturday
print('PASS' if not is_weekday(date(2026, 7, 25)) else 'FAIL')
" 2>&1) || infra_error "failed to run is_weekday check"

result=$(echo "$output" | tail -1)
if [ "$result" != "PASS" ]; then
    fail "BUG-P3 not fixed: is_weekday(Saturday) returned True (should be False)"
fi

# ── 2. is_business_day returns False for Saturday ──
echo "[] Checking is_business_day for Saturday..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.calendar_helpers import HolidayCalendar

cal = HolidayCalendar()
# 2026-07-25 is a Saturday
print('PASS' if not cal.is_business_day(date(2026, 7, 25)) else 'FAIL')
" 2>&1) || infra_error "failed to run is_business_day check"

result=$(echo "$output" | tail -1)
if [ "$result" != "PASS" ]; then
    fail "BUG-P3 not fixed: is_business_day(Saturday) returned True (should be False)"
fi

# ── 3. next/previous business day navigation works around weekends ──
echo "[] Checking business day navigation..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.calendar_helpers import next_business_day, previous_business_day

# next_business_day from Friday 7/24/2026 → Monday 7/27
next_fri = next_business_day(date(2026, 7, 24))
ok1 = (next_fri == date(2026, 7, 27))

# previous_business_day from Monday 7/27 → Friday 7/24
prev_mon = previous_business_day(date(2026, 7, 27))
ok2 = (prev_mon == date(2026, 7, 24))

print(f'next={next_fri} prev={prev_mon}')
print('PASS' if (ok1 and ok2) else 'FAIL')
" 2>&1) || infra_error "failed to run business day navigation check"

result=$(echo "$output" | tail -1)
if [ "$result" != "PASS" ]; then
    fail "BUG-P3 not fixed: business day navigation around weekends is incorrect"
fi

# ── 4. Root cause fixed in dates.py (is_weekday uses < 5, not <= 5) ──
assert_grep 'weekday() < 5' "$WORKSPACE/src/schedlib/dates.py" \
    "BUG-P3 root cause not fixed: is_weekday in dates.py still uses <= 5"

# ── 5. Regression test exists – check for tests covering is_weekday Saturday ──
check_regression_test "$WORKSPACE" "test_is_weekday_saturday\|is_weekday.*Saturday\|is_weekday.*date.*7.*25" \
    "no regression test found for is_weekday(Saturday) — red-herring archetype needs test coverage"

# ── 6. Revert-probe: apply seed overlay → tests fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-p3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Fix editable install .pth to point to scratch location
for pth_file in "$REVERT_SCRATCH"/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

# Apply seed overlay (restore buggy dates.py with <= 5)
apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH"

# Run relevant tests — must fail
if run_in_workspace "$REVERT_SCRATCH" .venv/bin/python -m pytest -q tests/test_dates.py tests/test_calendar_helpers.py 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-P3 — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed as expected when bug re-introduced" >&2

pass_ "BUG-P3: is_weekday(Sat)=False, business day nav correct, root cause in dates.py fixed, revert-probe passed"
