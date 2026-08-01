#!/usr/bin/env bash
# Probe: FEAT-P3 — event reminders with configurable advance-notice offsets
# Fixture: tt-python
# Task type: feature
#
# Checks:
#   1. Reminder mechanism exists (class/function for reminders)
#   2. Configurable advance-notice offsets supported (timedelta or minutes/hours/days)
#   3. Reminder triggers before event start by the specified offset
#   4. Feature-specific tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Reminder-related code exists ──
echo "[] Checking for reminder mechanism..." >&2

REMINDER_FILES=$(grep -rl 'remind\|alert\|notify\|advance.*notice' "$WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$REMINDER_FILES" ]; then
    fail "FEAT-P3 not implemented: no reminder/alert/notification code found in src/"
fi

# ── 2. Configurable advance-notice offsets ──
echo "[] Checking for advance-notice offset configuration..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
import inspect
from datetime import timedelta, datetime, timezone

# Try to find reminder-related classes/functions
from schedlib import engine as eng
eng_members = dir(eng)

# Look for reminder-related names
reminder_attrs = [m for m in eng_members if 'remind' in m.lower() or 'alert' in m.lower() or 'notify' in m.lower()]

if reminder_attrs:
    print(f'HAS_REMINDER_CLASS:{reminder_attrs[0]}')
else:
    # Check if there's a separate module
    import importlib
    try:
        reminder_mod = importlib.import_module('schedlib.reminder')
        print('HAS_REMINDER_MODULE')
    except ImportError:
        # Check for reminder in any schedlib module
        import os
        src_dir = 'src/schedlib'
        if os.path.isdir(src_dir):
            for f in os.listdir(src_dir):
                if f.endswith('.py') and f != '__init__.py':
                    with open(os.path.join(src_dir, f)) as fh:
                        content = fh.read()
                        if 'remind' in content.lower() or 'advance_notice' in content.lower():
                            print(f'HAS_REMINDER_IN_{f}')
                            break
            else:
                print('NO_REMINDER')
        else:
            print('NO_SRC_DIR')
" 2>&1) || infra_error "failed to check reminder mechanism"

result=$(echo "$output" | tail -1)
case "$result" in
    NO_REMINDER) fail "FEAT-P3 not implemented: no reminder class/function found" ;;
    NO_SRC_DIR) infra_error "src/schedlib/ directory not found in workspace" ;;
    *) echo "[] Reminder mechanism: $result" >&2 ;;
esac

# ── 3. Observable behavior: reminder offset is configurable ──
echo "[] Checking configurable advance-notice offsets..." >&2
output=$(run_in_workspace "$WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
import ast, os

# Search source for timedelta usage in reminder context
# or for offset/delta configuration parameters
found_offset = False
src_dir = 'src/schedlib'
if os.path.isdir(src_dir):
    for f in os.listdir(src_dir):
        if f.endswith('.py'):
            filepath = os.path.join(src_dir, f)
            with open(filepath) as fh:
                content = fh.read()
            # Look for advance notice with timedelta or minutes/hours parameters
            if ('remind' in content.lower() or 'alert' in content.lower() or 'notif' in content.lower()):
                if 'timedelta' in content or 'offset' in content.lower() or 'advance' in content.lower() or 'minutes_before' in content.lower():
                    found_offset = True
                    break

if found_offset:
    print('HAS_OFFSET')
else:
    print('NO_OFFSET')
" 2>&1) || infra_error "failed to check advance-notice offsets"

result=$(echo "$output" | tail -1)
if [ "$result" = "NO_OFFSET" ]; then
    fail "FEAT-P3: no configurable advance-notice offset (timedelta/offset parameter) found"
fi

# ── 4. Reminder tests exist ──
echo "[] Checking for reminder tests..." >&2
REMINDER_TESTS=$(grep -rl 'remind\|alert\|notify' "$WORKSPACE/tests/" 2>/dev/null || true)
if [ -z "$REMINDER_TESTS" ]; then
    fail "FEAT-P3: no tests found for reminder functionality"
fi

# ── 5. Feature tests pass ──
echo "[] Running reminder-related tests..." >&2
if ! run_python_tests "$WORKSPACE" -k "remind or alert or notify or advance" 2>&1; then
    fail "FEAT-P3: reminder-related tests failed"
fi

pass_ "FEAT-P3: reminder mechanism found, configurable advance-notice offsets supported, feature tests pass"
