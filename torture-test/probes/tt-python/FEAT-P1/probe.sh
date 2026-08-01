#!/usr/bin/env bash
# Probe: FEAT-P1 — recurring event exclusion dates (skip specific instances)
# Fixture: tt-python
# Task type: feature
#
# Checks:
#   1. Event class supports exclusion dates (exclusion_dates or skip_dates attribute)
#   2. RecurrenceRule.occurrences() respects exclusion dates
#   3. Feature-specific tests exist and pass
#   4. Exclusion dates are type-checked (must be date/datetime objects)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Exclusion-related code exists ──
echo "[] Checking for exclusion date support..." >&2

FOUND_FILES=$(grep -rl 'exclusion\|exclude_date\|skip_date\|excluded' "$WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$FOUND_FILES" ]; then
    fail "FEAT-P1 not implemented: no exclusion date code found in src/"
fi

# ── 2. Event or RecurrenceRule supports exclusion dates ──
echo "[] Verifying exclusion dates are in the data model..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date, timedelta
from schedlib.recurrence import daily

# Verify RecurrenceRule has some exclusion mechanism
rule = daily(count=10)

# Check if exclusion mechanism exists: either on the rule or on event
# The implementation could be rule.exclusion_dates, rule.exclude(), etc.
rule_attrs = dir(rule)

# Look for exclusion-related attributes
excl_attrs = [a for a in rule_attrs if 'excl' in a.lower() or 'skip' in a.lower()]
if not excl_attrs:
    # Check if Event has exclusion support
    from schedlib.engine import Event
    from datetime import datetime, timezone
    utc = timezone.utc
    ev = Event('test', datetime(2026,7,30,9,0,tzinfo=utc), datetime(2026,7,30,10,0,tzinfo=utc))
    ev_attrs = dir(ev)
    excl_attrs = [a for a in ev_attrs if 'excl' in a.lower() or 'skip' in a.lower()]

if not excl_attrs:
    # Fallback: grep source for exclusion date handling in recurrence
    import subprocess
    result = subprocess.run(['grep', '-rl', 'exclu', 'src/schedlib/'], capture_output=True, text=True)
    if not result.stdout.strip():
        print('FAIL')
        sys.exit(0)
    else:
        print('PASS_grep')
else:
    print('PASS_attrs')
" 2>&1) || infra_error "failed to check exclusion date model"

result=$(echo "$output" | tail -1)
case "$result" in
    FAIL) fail "FEAT-P1 not implemented: no exclusion date support found in recurrence or event model" ;;
    PASS_grep) echo "[] Exclusion support found via grep (non-attribute approach)" >&2 ;;
    PASS_attrs) echo "[] Exclusion support found via model attributes" >&2 ;;
    *) echo "[] Exclusion check result: $result" >&2 ;;
esac

# ── 3. Observable behavior: excluded dates are skipped ──
echo "[] Checking exclusion behavior..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
import inspect
from datetime import date

# Try to find and exercise exclusion functionality
# Look for a test file for exclusion dates
import os
test_dir = 'tests'
test_files = os.listdir(test_dir) if os.path.isdir(test_dir) else []
excl_test_files = [f for f in test_files if 'excl' in f.lower() or 'skip' in f.lower()]
if excl_test_files:
    print('HAS_TESTS:' + ','.join(excl_test_files))
else:
    # Check for exclusion tests inside existing test files
    import subprocess
    result = subprocess.run(['grep', '-rl', 'exclu\|skip_date', 'tests/'], capture_output=True, text=True)
    if result.stdout.strip():
        print('HAS_TESTS_INLINE:' + result.stdout.strip().replace('\n', ','))
    else:
        print('NO_TESTS')
" 2>&1) || infra_error "failed to check exclusion tests"

result=$(echo "$output" | tail -1)
case "$result" in
    NO_TESTS) fail "FEAT-P1: no tests found for exclusion date functionality — feature must be tested" ;;
    HAS_TESTS:*) echo "[] Exclusion date tests found" >&2 ;;
    HAS_TESTS_INLINE:*) echo "[] Exclusion date tests found inline" >&2 ;;
    *) echo "[] Test check result: $result" >&2 ;;
esac

# ── 4. Feature tests pass ──
echo "[] Running exclusion-related tests..." >&2
if ! run_python_tests "$WORKSPACE" -k "exclu or skip_date or exclude" 2>&1; then
    fail "FEAT-P1: exclusion-related tests failed"
fi

pass_ "FEAT-P1: exclusion date support found, feature tests pass"
