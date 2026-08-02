#!/usr/bin/env bash
# Probe: POLY-FEAT-P2 — timezone-aware scheduling with IANA timezone support
# Fixture: tt-poly-lite (python/ subtree)
# Task type: feature
#
# Checks:
#   1. IANA timezone support imported (zoneinfo from stdlib)
#   2. Event model handles IANA timezone strings
#   3. Feature-specific tests exist and pass

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"

# ── 1. IANA timezone support imported ──
echo "[] Checking for IANA timezone support (zoneinfo)..." >&2

ZONEINFO_FILES=$(grep -rl 'zoneinfo\|pytz' "$PY_WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$ZONEINFO_FILES" ]; then
    fail "POLY-FEAT-P2 not implemented: no zoneinfo/pytz import found in python/src/"
fi

# ── 2. Event model accepts IANA timezone strings ──
echo "[] Verifying IANA timezone handling..." >&2
output=$(run_in_workspace "$PY_WORKSPACE" .venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from datetime import datetime
from schedlib.engine import Event

# Try to create an event with an IANA timezone string
try:
    import inspect
    sig = inspect.signature(Event.__init__)
    params = list(sig.parameters.keys())
    tz_params = [p for p in params if 'tz' in p.lower() or 'zone' in p.lower() or 'timezone' in p.lower()]

    if tz_params:
        print(f'HAS_TZ_PARAM:{','.join(tz_params)}')
    else:
        import zoneinfo
        tz = zoneinfo.ZoneInfo('America/New_York')
        ev = Event('test', datetime(2026,7,30,9,0,tzinfo=tz), datetime(2026,7,30,10,0,tzinfo=tz))
        print('HAS_DIRECT_IANA')
except ImportError:
    try:
        import pytz
        tz = pytz.timezone('America/New_York')
        ev = Event('test', datetime(2026,7,30,9,0,tzinfo=tz), datetime(2026,7,30,10,0,tzinfo=tz))
        print('HAS_PYTZ')
    except:
        print('FAIL_NO_TZ')
except Exception as e:
    print(f'FAIL:{e}')
" 2>&1) || infra_error "failed to check IANA timezone support"

result=$(echo "$output" | tail -1)
case "$result" in
    FAIL_NO_TZ) fail "POLY-FEAT-P2 not implemented: cannot create Event with IANA timezone" ;;
    FAIL:*) fail "POLY-FEAT-P2: error creating timezone-aware event: $result" ;;
    *) echo "[] IANA timezone support: $result" >&2 ;;
esac

# ── 3. Timezone-related tests exist ──
echo "[] Checking for timezone tests..." >&2
TZ_TESTS=$(grep -rl 'zoneinfo\|pytz\|timezone.*IANA\|America/New_York\|tz_db' "$PY_WORKSPACE/tests/" 2>/dev/null || true)
if [ -z "$TZ_TESTS" ]; then
    fail "POLY-FEAT-P2: no tests found for IANA timezone functionality"
fi

# ── 4. Feature tests pass ──
echo "[] Running timezone-related tests..." >&2
if ! run_python_tests "$PY_WORKSPACE" -k "timezone or zoneinfo or tz or iana" 2>&1; then
    fail "POLY-FEAT-P2: timezone-related tests failed"
fi

pass_ "POLY-FEAT-P2: IANA timezone support ($result), feature tests pass"
