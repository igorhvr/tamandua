#!/usr/bin/env bash
# Probe: FEAT-T1 — custom expense categories management
# Fixture: tt-ts
# Task type: feature (frontend)
#
# Checks:
#   1. Category management UI code exists (add/remove/rename categories)
#   2. New categories appear in dropdown
#   3. Category management API endpoints exist (if server-side)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Category management code exists ──
echo "[] Checking for category management implementation..." >&2

FOUND_CAT=$(grep -rli 'category.*add\|addCategory\|newCategory\|manage.*categor\|category.*manage\|category.*rename\|renameCategory\|category.*delete\|deleteCategory\|removeCategory' \
    "$WORKSPACE/public/" "$WORKSPACE/src/" 2>/dev/null || true)

if [ -z "$FOUND_CAT" ]; then
    fail "FEAT-T1 not implemented: no category management code found"
fi

# ── 2. Category API endpoint exists (if backend-driven) ──
echo "[] Checking for category API endpoints..." >&2
if grep -q "categories" "$WORKSPACE/src/server.ts" 2>/dev/null; then
    echo "[] Category endpoints found in server.ts" >&2
else
    echo "[] Note: no dedicated /api/categories endpoint found — feature may be frontend-only" >&2
fi

# ── 3. Check for category-related UI elements ──
echo "[] Checking for category UI elements..." >&2
if grep -qi "category.*select\|category.*dropdown\|category.*option\|category.*form" "$WORKSPACE/public/"*.html "$WORKSPACE/public/"*.js 2>/dev/null; then
    echo "[] Category UI elements found" >&2
else
    fail "FEAT-T1 not implemented: no category UI elements (select/dropdown) found in frontend"
fi

# ── 4. Feature tests exist ──
echo "[] Checking for feature tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-T1\|category.*manage\|addCategory\|newCategory\|rename.*category" \
    "FEAT-T1: no tests found for category management"

# ── 5. Run feature-specific tests ──
echo "[] Running FEAT-T1 tests..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="category" src/ 2>&1; then
    fail "FEAT-T1: category-related tests do not pass"
fi

pass_ "FEAT-T1: category management implementation found, UI elements present, tests pass"
