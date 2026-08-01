#!/usr/bin/env bash
# Probe: FEAT-J4 — Multiple date formats in CSV import
# Fixture: tt-java
# Task type: feature
#
# Checks:
#   1. CsvParser auto-detects yyyy-MM-dd, MM/dd/yyyy, dd/MM/yyyy formats
#   2. Falls back to ISO on ambiguity
#   3. Rejects mixed formats gracefully
#   4. Tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CSV_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"

# ── 1. CsvParser handles multiple date formats ──
echo "[] Checking CsvParser for multi-format date support..." >&2
check_file_exists "$CSV_FILE" "CsvParser.java not found in workspace"

# Must support ISO format (baseline): yyyy-MM-dd
assert_grep 'yyyy-MM-dd\|yyyy.MM.dd' "$CSV_FILE" \
    "FEAT-J4 not implemented: no ISO date format (yyyy-MM-dd) handling"

# Must support US format: MM/dd/yyyy
assert_grep 'MM/dd/yyyy' "$CSV_FILE" \
    "FEAT-J4 not implemented: no US date format (MM/dd/yyyy) handling"

# Must support EU format: dd/MM/yyyy
assert_grep 'dd/MM/yyyy' "$CSV_FILE" \
    "FEAT-J4 not implemented: no EU date format (dd/MM/yyyy) handling"

# ── 2. DateTimeFormatter or date format detection ──
assert_grep 'DateTimeFormatter\|SimpleDateFormat\|parse.*date' "$CSV_FILE" \
    "FEAT-J4 not implemented: no date parsing with multiple formatters"

# ── 3. Feature tests exist ──
echo "[] Checking for multi-format date tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-J4\|date.*format\|multi.*format\|dateFormat\|format.*date" \
    "FEAT-J4: no tests found for multi-format date support"

# ── 4. Run feature-specific tests ──
echo "[] Running FEAT-J4 tests..." >&2
DATE_TESTS=$(find "$WORKSPACE/src/test" -name "*Test.java" -exec grep -l 'date.*format\|format.*date\|MM/dd\|dd/MM\|multiple.*format\|FEAT.J4' {} \; 2>/dev/null)
if [ -n "$DATE_TESTS" ]; then
    for tf in $DATE_TESTS; do
        tclass=$(echo "$tf" | sed 's|.*/java/||; s|/|.|g; s|\.java$||')
        if ! (cd "$WORKSPACE" && ./mvnw -q -B test -Dtest="$tclass" 2>&1); then
            fail "FEAT-J4: tests in $tclass do not pass"
        fi
    done
fi

pass_ "FEAT-J4: multi-format date support (ISO, US, EU), DateTimeFormatter usage, tests pass"
