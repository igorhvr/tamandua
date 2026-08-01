#!/usr/bin/env bash
# Probe: FEAT-J2 — Monthly summary report with income/expense breakdown
# Fixture: tt-java
# Task type: feature
#
# Checks:
#   1. CliApp supports "report monthly" subcommand
#   2. LedgerService has getMonthlyTotals() returning Map<YearMonth, BigDecimal>
#   3. Report output has month/total table format
#   4. Tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CLI_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/CliApp.java"
SVC_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. CLI supports report monthly ──
echo "[] Checking CliApp for report monthly subcommand..." >&2
check_file_exists "$CLI_FILE" "CliApp.java not found in workspace"

assert_grep 'report.*monthly\|\"report\"' "$CLI_FILE" \
    "FEAT-J2 not implemented: no 'report monthly' subcommand in CliApp"

# ── 2. LedgerService has getMonthlyTotals ──
echo "[] Checking LedgerService for getMonthlyTotals..." >&2
check_file_exists "$SVC_FILE" "LedgerService.java not found in workspace"

assert_grep 'getMonthlyTotals\|getMonthlyBreakdown' "$SVC_FILE" \
    "FEAT-J2 not implemented: no getMonthlyTotals method in LedgerService"

# ── 3. Report output has month/table format ──
echo "[] Checking for monthly report formatting..." >&2
if ! grep -qi 'Month\|month\|YearMonth' "$CLI_FILE" 2>/dev/null; then
    echo "[] Note: month formatting not detected in CliApp via grep" >&2
fi

# ── 4. Feature tests exist ──
echo "[] Checking for monthly report tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-J2\|monthly\|getMonthlyTotals\|report.*month" \
    "FEAT-J2: no tests found for monthly report"

# ── 5. Run feature-specific tests ──
echo "[] Running FEAT-J2 tests..." >&2
MONTH_TESTS=$(find "$WORKSPACE/src/test" -name "*Test.java" -exec grep -l 'monthly\|Monthly\|FEAT.J2\|getMonthly' {} \; 2>/dev/null)
if [ -n "$MONTH_TESTS" ]; then
    for tf in $MONTH_TESTS; do
        tclass=$(echo "$tf" | sed 's|.*/java/||; s|/|.|g; s|\.java$||')
        if ! (cd "$WORKSPACE" && ./mvnw -q -B test -Dtest="$tclass" 2>&1); then
            fail "FEAT-J2: tests in $tclass do not pass"
        fi
    done
fi

pass_ "FEAT-J2: report monthly subcommand, getMonthlyTotals in LedgerService, tests pass"
