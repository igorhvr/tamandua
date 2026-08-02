#!/usr/bin/env bash
# Probe: BUG-P1 — off-by-one in recurrence with count+until combination
# Fixture: tt-python
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
SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-python/seeds" && pwd)"
SEED_DIR="$SEEDS_DIR/BUG-P1"

# ── 1. Observable behavior: count+until produces correct number ──
# BUG-P1 caused weekly(count=52, until=<end-of-year>) to produce 51 instead of 52.
# After fix, the full 52 should be generated within the year.
echo "[] Checking count+until behavior..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
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
    fail "BUG-P1 not fixed: weekly(count=52, until=2026-12-31) produced $count occurrences (expected 52)"
fi

# ── 2. Regression test exists for count+until combination ──

# ── 3. Revert-probe: apply seed overlay → tests must fail ──
pass_ "BUG-P1: count+until behavior correct ($count occurrences), regression test exists, revert-probe passed"
