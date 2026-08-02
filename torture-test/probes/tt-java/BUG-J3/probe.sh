#!/usr/bin/env bash
# Probe: BUG-J3 — red-herring column-index swap (amount ↔ category)
# Fixture: tt-java
# Task type: bug (A3 — red-herring)
#
# Checks:
#   1. CsvParser.parse() uses correct column indices (amount=field[3], category=field[4])
#   2. No swapped indices (amount from field[4], category from field[3])

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CSV_PARSER="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"

# ── 1. CsvParser has correct column indices ──
echo "[] Checking CsvParser column indices..." >&2
check_file_exists "$CSV_PARSER" "CsvParser.java not found in workspace"

# The buggy code swaps: amount=fields.get(4), category=fields.get(3)
# The fixed code uses: amount=fields.get(3), category=fields.get(4)

# Check that category is NOT from fields[3] (buggy pattern)
assert_not_grep 'fields\.get(3).*category\|category.*fields\.get(3)' "$CSV_PARSER" \
    "BUG-J3 not fixed: category still read from field[3] (should be field[4])"

# Check that BigDecimal amount is NOT from fields[4] (buggy pattern)  
assert_not_grep 'fields\.get(4).*BigDecimal\|BigDecimal.*fields\.get(4)' "$CSV_PARSER" \
    "BUG-J3 not fixed: amount still read from field[4] (should be field[3])"

pass_ "BUG-J3: correct column indices (amount=field[3], category=field[4])"
