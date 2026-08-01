#!/usr/bin/env bash
# Probe: POLY-FEAT-P3 — event reminders with configurable advance-notice offsets
# Fixture: tt-poly-lite (python/ subtree)
# Task type: feature
#
# Checks:
#   1. Reminder mechanism exists (class/function for reminders)
#   2. Configurable advance-notice offsets supported (timedelta or minutes/hours/days)
#   3. Feature-specific tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"

# ── 1. Reminder-related code exists ──
echo "[] Checking for reminder mechanism..." >&2

REMINDER_FILES=$(grep -rl 'remind\|alert\|notify\|advance.*notice' "$PY_WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$REMINDER_FILES" ]; then
    fail "POLY-FEAT-P3 not implemented: no reminder/alert/notification code found in python/src/"
fi

# ── 2. Configurable advance-notice offsets ──
echo "[] Checking for advance-notice offset configuration..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
import os

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
            if ('remind' in content.lower() or 'alert' in content.lower() or 'notif' in content.lower()):
                if 'timedelta' in content or 'offset' in content.lower() or 'advance' in content.lower() or 'minutes_before' in content.lower() or 'advance_notice' in content.lower():
                    found_offset = True
                    break

if found_offset:
    print('HAS_OFFSET')
else:
    print('NO_OFFSET')
" 2>&1) || infra_error "failed to check advance-notice offsets"

result=$(echo "$output" | tail -1)
if [ "$result" = "NO_OFFSET" ]; then
    fail "POLY-FEAT-P3: no configurable advance-notice offset (timedelta/offset parameter) found"
fi

# ── 3. Reminder tests exist ──
echo "[] Checking for reminder tests..." >&2
REMINDER_TESTS=$(grep -rl 'remind\|alert\|notify' "$PY_WORKSPACE/tests/" 2>/dev/null || true)
if [ -z "$REMINDER_TESTS" ]; then
    fail "POLY-FEAT-P3: no tests found for reminder functionality"
fi

# ── 4. Feature tests pass ──
echo "[] Running reminder-related tests..." >&2
if ! run_python_tests "$PY_WORKSPACE" -k "remind or alert or notify or advance" 2>&1; then
    fail "POLY-FEAT-P3: reminder-related tests failed"
fi

pass_ "POLY-FEAT-P3: reminder mechanism found, configurable advance-notice offsets supported, feature tests pass"
