#!/usr/bin/env bash
# Probe: FEAT-T2 — monthly expense dashboard with bar chart (Canvas API)
# Fixture: tt-ts
# Task type: feature (frontend)
#
# Checks:
#   1. Dashboard page or section exists
#   2. Bar chart uses Canvas API (no chart library)
#   3. Month navigation exists
#   4. No external chart library dependency

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Dashboard page/section exists ──
echo "[] Checking for dashboard..." >&2
FOUND_DASH=$(grep -rli 'dashboard' "$WORKSPACE/public/" "$WORKSPACE/src/" 2>/dev/null || true)
if [ -z "$FOUND_DASH" ]; then
    fail "FEAT-T2 not implemented: no dashboard found"
fi

# ── 2. Canvas API usage ──
echo "[] Checking for Canvas API usage..." >&2
FOUND_CANVAS=$(grep -rli 'getContext\|<canvas\|canvas' "$WORKSPACE/public/"*.js "$WORKSPACE/public/"*.html 2>/dev/null || true)
if [ -z "$FOUND_CANVAS" ]; then
    fail "FEAT-T2 not implemented: no Canvas API usage found in frontend"
fi

# ── 3. Month navigation exists ──
echo "[] Checking for month navigation..." >&2
if grep -qi 'next.*month\|prev.*month\|month.*navigat\|month.*selector' "$WORKSPACE/public/"*.js "$WORKSPACE/public/"*.html 2>/dev/null; then
    echo "[] Month navigation found" >&2
else
    echo "[] Note: month navigation not detected via grep — may use different naming" >&2
fi

# ── 4. No external chart library ──
echo "[] Checking no external chart library..." >&2
for lib in 'chart\.js\|chartjs\|Chart\.js\|d3\.js\|highcharts\|plotly'; do
    if grep -rqi "$lib" "$WORKSPACE/public/"*.html "$WORKSPACE/public/"*.js 2>/dev/null; then
        fail "FEAT-T2: external chart library detected ($lib) — must use Canvas API directly"
    fi
done

# ── 5. Feature tests exist ──
echo "[] Checking for dashboard tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-T2\|dashboard\|bar.*chart\|canvas" \
    "FEAT-T2: no tests found for dashboard/bar chart"

# ── 6. Run feature-specific tests ──
echo "[] Running FEAT-T2 tests..." >&2
if ! run_in_workspace "$WORKSPACE" npx tsx --test --test-name-pattern="dashboard\|FEAT-T2\|chart\|canvas" src/ 2>&1; then
    fail "FEAT-T2: dashboard/bar chart tests do not pass"
fi

pass_ "FEAT-T2: dashboard found, Canvas API bar chart implementation, no external chart lib, tests pass"
