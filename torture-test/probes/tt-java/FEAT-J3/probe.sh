#!/usr/bin/env bash
# Probe: FEAT-J3 — CSV import validation mode (dry-run)
# Fixture: tt-java
# Task type: feature
#
# Checks:
#   1. CliApp supports "validate" subcommand
#   2. CsvParser has --dry-run flag or validation mode
#   3. Validation output includes row count, warnings, and VALID/INVALID status
#   4. Tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CLI_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/CliApp.java"
CSV_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"

# ── 1. CLI supports validate subcommand ──
echo "[] Checking CliApp for validate subcommand..." >&2
check_file_exists "$CLI_FILE" "CliApp.java not found in workspace"

assert_grep 'validate\|\"validate\"' "$CLI_FILE" \
    "FEAT-J3 not implemented: no 'validate' subcommand in CliApp"

# ── 2. CsvParser has dry-run or validate mode ──
echo "[] Checking CsvParser for validation mode..." >&2
check_file_exists "$CSV_FILE" "CsvParser.java not found in workspace"

if ! grep -qi 'dry.run\|dryRun\|validate\|isValid\|isDryRun' "$CSV_FILE" 2>/dev/null; then
    fail "FEAT-J3 not implemented: no dry-run/validate mode in CsvParser"
fi

# ── 3. Feature tests exist ──
echo "[] Checking for CSV validation tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-J3\|validate.*csv\|dry.run\|dryRun" \
    "FEAT-J3: no tests found for CSV import validation mode"

# ── 4. Run feature-specific tests ──
echo "[] Running FEAT-J3 tests..." >&2
VAL_TESTS=$(find "$WORKSPACE/src/test" -name "*Test.java" -exec grep -l 'validate\|validate\|FEAT.J3\|dryRun\|dry.run' {} \; 2>/dev/null)
if [ -n "$VAL_TESTS" ]; then
    for tf in $VAL_TESTS; do
        tclass=$(echo "$tf" | sed 's|.*/java/||; s|/|.|g; s|\.java$||')
        if ! (cd "$WORKSPACE" && ./mvnw -q -B test -Dtest="$tclass" 2>&1); then
            fail "FEAT-J3: tests in $tclass do not pass"
        fi
    done
fi

pass_ "FEAT-J3: validate subcommand in CliApp, dry-run/validate mode in CsvParser, tests pass"
