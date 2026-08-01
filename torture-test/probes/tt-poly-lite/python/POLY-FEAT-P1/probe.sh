#!/usr/bin/env bash
# Probe: POLY-FEAT-P1 — recurring event exclusion dates (skip specific instances)
# Fixture: tt-poly-lite (python/ subtree)
# Task type: feature
#
# Checks:
#   1. Exclusion-related code exists in python/src/schedlib/
#   2. Event or RecurrenceRule supports exclusion dates
#   3. Feature-specific tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"

# ── 1. Exclusion-related code exists ──
echo "[] Checking for exclusion date support..." >&2

FOUND_FILES=$(grep -rl 'exclusion\|exclude_date\|skip_date\|excluded' "$PY_WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$FOUND_FILES" ]; then
    fail "POLY-FEAT-P1 not implemented: no exclusion date code found in python/src/"
fi

# ── 2. Event or RecurrenceRule supports exclusion dates ──
echo "[] Verifying exclusion dates are in the data model..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import date
from schedlib.recurrence import daily

# Verify RecurrenceRule has some exclusion mechanism
rule = daily(count=10)

# Check if exclusion mechanism exists: either on the rule or on event
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
    FAIL) fail "POLY-FEAT-P1 not implemented: no exclusion date support found in recurrence or event model" ;;
    PASS_grep) echo "[] Exclusion support found via grep (non-attribute approach)" >&2 ;;
    PASS_attrs) echo "[] Exclusion support found via model attributes" >&2 ;;
    *) echo "[] Exclusion check result: $result" >&2 ;;
esac

# ── 3. Exclusion-related tests exist ──
echo "[] Checking for exclusion tests..." >&2
EXCL_TESTS=$(grep -rl 'exclu\|skip_date\|exclude' "$PY_WORKSPACE/tests/" 2>/dev/null || true)
if [ -z "$EXCL_TESTS" ]; then
    fail "POLY-FEAT-P1: no tests found for exclusion date functionality — feature must be tested"
fi

# ── 4. Feature tests pass ──
echo "[] Running exclusion-related tests..." >&2
if ! run_python_tests "$PY_WORKSPACE" -k "exclu or skip_date or exclude" 2>&1; then
    fail "POLY-FEAT-P1: exclusion-related tests failed"
fi

pass_ "POLY-FEAT-P1: exclusion date support found, feature tests pass"
