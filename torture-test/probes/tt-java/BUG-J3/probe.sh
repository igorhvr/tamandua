#!/usr/bin/env bash
# Probe: BUG-J3 — red-herring column-index swap (amount ↔ category)
# Fixture: tt-java
# Task type: bug (A3 — red-herring)
#
# Checks:
#   1. CsvParser.parse() uses correct column indices (amount=field[3], category=field[4])
#   2. Regression test exists for column-index correctness
#   3. Revert-probe: apply seed patch → tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-java/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-J3.patch"

CSV_PARSER="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"

# ── 1. CsvParser has correct column indices ──
echo "[] Checking CsvParser column indices..." >&2
check_file_exists "$CSV_PARSER" "CsvParser.java not found in workspace"

# The fix: amount = fields[3], category = fields[4]
# The bug: amount from fields[4], category from fields[3]
# Check that amount is parsed from the correct index (should be the 4th field = index 3)
assert_grep 'fields\[3\]\|field(3)\|get(3)' "$CSV_PARSER" \
    "BUG-J3 not fixed: amount field index 3 not found in CsvParser.java"

assert_grep 'fields\[4\]\|field(4)\|get(4)' "$CSV_PARSER" \
    "BUG-J3 not fixed: category field index 4 not found in CsvParser.java"

# ── 2. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "regressionBugJ3" \
    "BUG-J3: no regression test found for column-index swap"

# ── 3. Revert-probe: apply seed patch → tests fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-j3"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-J3 revert-probe: failed to apply seed patch"
fi

# Run tests — must fail (columns swapped, amounts become zero, tests catch it)
if (cd "$REVERT_SCRATCH" && ./mvnw -q -B test 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: tests passed after re-introducing BUG-J3 column swap — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: tests caught the re-introduced column swap" >&2

pass_ "BUG-J3: correct column indices, regression test exists, revert-probe passed"
