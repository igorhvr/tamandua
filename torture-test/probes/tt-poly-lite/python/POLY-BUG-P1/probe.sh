#!/usr/bin/env bash
# Probe: POLY-BUG-P1 — off-by-one in recurrence with count+until combination
# Fixture: tt-poly-lite (python/ subtree)
# Task type: bug (A1 — fixer must write the regression test)
#
# Checks:
#   1. weekly(count=52, until=<end-of-year>) produces 52 occurrences (not 51)
#   2. Regression test exists for the count+until combination
#   3. Revert-probe: apply seed overlay → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── Locate seeds directory ──
SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-poly-lite/python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/POLY-BUG-P1"
PY_WORKSPACE="$WORKSPACE/python"

# ── 1. Observable behavior: count+until produces correct number ──
echo "[] Checking count+until behavior..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.recurrence import weekly

# 52 weeks in 2026: Jan 5, 2026 (first Monday) to Dec 28, 2026 (last Monday)
rule = weekly(count=52, until=date(2026, 12, 31))
results = rule.occurrences(date(2026, 1, 5), date(2027, 1, 4))
print(len(results))
" 2>&1) || infra_error "failed to run count+until check"

count=$(echo "$output" | tail -1)
if [ "$count" -ne 52 ]; then
    fail "POLY-BUG-P1 not fixed: weekly(count=52, until=2026-12-31) produced $count occurrences (expected 52)"
fi

# ── 2. Regression test exists for count+until combination ──
check_regression_test "$WORKSPACE/python" "count.*until\|until.*count\|count_and_until\|test_count_and_until" \
    "no regression test found for count+until combination — fixer must write one per A1 archetype"

# ── 3. Revert-probe: apply seed overlay → tests must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-poly-bug-p1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

# Fix editable install .pth to point to scratch location
for pth_file in "$REVERT_SCRATCH"/python/.venv/lib/python*/site-packages/__editable__.*.pth; do
    if [ -f "$pth_file" ]; then
        sed -i "s|^${WORKSPACE}|${REVERT_SCRATCH}|" "$pth_file"
    fi
done

# Apply seed overlay (restore buggy recurrence.py)
apply_seed_overlay "$SEED_DIR" "$REVERT_SCRATCH/python"

# Run recurrence tests — must fail (at least one test should catch the re-introduced bug)
if run_in_workspace "$REVERT_SCRATCH/python" .venv/bin/python -m pytest -q tests/test_recurrence.py 2>&1; then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing POLY-BUG-P1 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests failed as expected when bug re-introduced" >&2

pass_ "POLY-BUG-P1: count+until behavior correct ($count occurrences), regression test exists, revert-probe passed"
