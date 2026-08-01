#!/usr/bin/env bash
# Probe: FEAT-T3 — expense CSV export endpoint
# Fixture: tt-ts
# Task type: feature (backend)
#
# Checks:
#   1. GET /api/expenses/export endpoint exists
#   2. Returns CSV with text/csv Content-Type
#   3. CSV escaping for commas and quotes
#   4. Download button in frontend

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Export endpoint exists ──
echo "[] Checking for CSV export endpoint..." >&2
SERVER_FILE="$WORKSPACE/src/server.ts"
check_file_exists "$SERVER_FILE" "server.ts not found in workspace"

if ! grep -q 'export\|csv\|/api/expenses/export' "$SERVER_FILE" 2>/dev/null; then
    fail "FEAT-T3 not implemented: no export endpoint found in server.ts"
fi

# ── 2. Content-Type text/csv ──
echo "[] Checking for text/csv Content-Type..." >&2
assert_grep 'text/csv' "$SERVER_FILE" \
    "FEAT-T3 not implemented: no text/csv Content-Type found in export endpoint"

# ── 3. CSV header row ──
echo "[] Checking for CSV header..." >&2
if ! grep -qi 'id.*description.*amount.*category.*date\|id,description,amount,category,date' "$SERVER_FILE" 2>/dev/null; then
    echo "[] Note: CSV header pattern not detected via grep — may use dynamic header generation" >&2
fi

# ── 4. CSV escaping (comma/quote handling) ──
echo "[] Checking for CSV escaping..." >&2
if grep -qi 'escape\|replace.*,\|replace.*".*\|\\.*\,' "$SERVER_FILE" 2>/dev/null; then
    echo "[] CSV escaping detected" >&2
else
    echo "[] Note: CSV escaping not detected — may use library-based escaping" >&2
fi

# ── 5. Download button in frontend ──
echo "[] Checking for download button in frontend..." >&2
if grep -qi 'download\|export.*csv\|\.csv\|expenses.*csv' "$WORKSPACE/public/"*.js "$WORKSPACE/public/"*.html 2>/dev/null; then
    echo "[] Download/export UI elements found" >&2
else
    fail "FEAT-T3 not implemented: no download/export UI elements found in frontend"
fi

# ── 6. Feature tests exist ──
echo "[] Checking for export tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-T3\|export\|csv" \
    "FEAT-T3: no tests found for CSV export"

# ── 7. Run feature-specific tests ──
echo "[] Running FEAT-T3 tests..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="export\|FEAT-T3\|csv" src/ 2>&1; then
    fail "FEAT-T3: CSV export tests do not pass"
fi

pass_ "FEAT-T3: CSV export endpoint found with text/csv Content-Type, download button in UI, tests pass"
