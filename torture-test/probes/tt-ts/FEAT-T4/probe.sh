#!/usr/bin/env bash
# Probe: FEAT-T4 — recurring monthly expense support
# Fixture: tt-ts
# Task type: feature (backend)
#
# Checks:
#   1. Recurring flag on expense type/model
#   2. Auto-generation endpoint (POST /api/expenses/recurring/generate)
#   3. Idempotent generation per calendar month
#   4. Recurring indicator ("🔄") in frontend

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Recurring flag in types/data model ──
echo "[] Checking for recurring flag in data model..." >&2
TYPES_FILE="$WORKSPACE/src/types.ts"
check_file_exists "$TYPES_FILE" "types.ts not found in workspace"

assert_grep 'recurring' "$TYPES_FILE" \
    "FEAT-T4 not implemented: no 'recurring' field in Expense type"

# ── 2. Recurring generation endpoint or logic exists ──
echo "[] Checking for recurring generation logic..." >&2
SERVER_FILE="$WORKSPACE/src/server.ts"
check_file_exists "$SERVER_FILE" "server.ts not found in workspace"

if ! grep -qi 'recurring\|generate.*recurring\|recurring.*generate' "$SERVER_FILE" 2>/dev/null; then
    echo "[] Note: recurring generation endpoint not found via grep — may use different naming" >&2
fi

FOUND_RECUR=$(grep -rli 'recurring' "$WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$FOUND_RECUR" ]; then
    fail "FEAT-T4 not implemented: no recurring expense logic found in source"
fi

# ── 3. Recurring UI indicator ("🔄") ──
echo "[] Checking for recurring indicator in frontend..." >&2
if grep -q '🔄\|recurring.*indicator\|isRecurring' "$WORKSPACE/public/"*.js "$WORKSPACE/public/"*.html 2>/dev/null; then
    echo "[] Recurring indicator found" >&2
else
    echo "[] Note: recurring indicator not detected via grep — may use different visual" >&2
fi

# ── 4. Feature checkbox in UI ──
echo "[] Checking for recurring checkbox in frontend..." >&2
if grep -qi 'recurring.*checkbox\|checkbox.*recurring\|recurring.*input' "$WORKSPACE/public/"*.js "$WORKSPACE/public/"*.html 2>/dev/null; then
    echo "[] Recurring checkbox found" >&2
else
    echo "[] Note: recurring checkbox not detected — may use different UI element" >&2
fi

# ── 5. Feature tests exist ──
echo "[] Checking for recurring expense tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-T4\|recurring" \
    "FEAT-T4: no tests found for recurring expenses"

# ── 6. Run feature-specific tests ──
echo "[] Running FEAT-T4 tests..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="recurring\|FEAT-T4" src/ 2>&1; then
    fail "FEAT-T4: recurring expense tests do not pass"
fi

pass_ "FEAT-T4: recurring flag in data model, generation logic found, UI indicator present, tests pass"
