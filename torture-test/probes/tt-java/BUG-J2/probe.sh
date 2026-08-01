#!/usr/bin/env bash
# Probe: BUG-J2 — two-module bug (null on empty CSV + NPE on null list)
# Fixture: tt-java
# Task type: bug (A2 — two-module coordinated)
#
# Checks:
#   1. CsvParser.parse() returns empty list for header-only CSV (not null)
#   2. LedgerService.getTotal() has null guard
#   3. Regression tests exist for both fixes
#   4. Revert-probe: apply seed patch → regression tests fail

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-java/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-J2.patch"

CSV_PARSER="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"
LEDGER_SVC="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. CsvParser returns empty list for header-only CSV ──
echo "[] Checking CsvParser.parse() for header-only CSV handling..." >&2
check_file_exists "$CSV_PARSER" "CsvParser.java not found in workspace"

# Must not return null for empty CSV — look for empty list return
assert_grep 'Collections.emptyList\|new ArrayList.*\(\)\|\breturn\s\+new.*List' "$CSV_PARSER" \
    "BUG-J2 not fixed: CsvParser does not return empty list for header-only CSV"

# ── 2. LedgerService.getTotal() has null guard ──
echo "[] Checking LedgerService.getTotal() for null guard..." >&2
check_file_exists "$LEDGER_SVC" "LedgerService.java not found in workspace"

assert_grep 'null' "$LEDGER_SVC" \
    "BUG-J2 not fixed: LedgerService.getTotal() lacks null guard"

# ── 3. Regression tests exist ──
echo "[] Checking for regression tests..." >&2
check_regression_test "$WORKSPACE" "regressionBugJ2EmptyCsvReturnsEmptyList" \
    "BUG-J2: no regression test found for empty CSV returning empty list"
check_regression_test "$WORKSPACE" "regressionBugJ2GetTotalNullListReturnsZero" \
    "BUG-J2: no regression test found for getTotal null guard"

# ── 4. Revert-probe: apply seed patch → regression tests fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-j2"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-J2 revert-probe: failed to apply seed patch"
fi

# Run tests — must fail (both files broken, tests catch them)
if (cd "$REVERT_SCRATCH" && ./mvnw -q -B test -Dtest="CsvParserTest#regressionBugJ2EmptyCsvReturnsEmptyList,LedgerServiceTest#regressionBugJ2GetTotalNullListReturnsZero" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: BUG-J2 regression tests passed after re-introducing bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression tests caught the re-introduced bugs" >&2

pass_ "BUG-J2: CsvParser returns empty list, LedgerService has null guard, regression tests exist, revert-probe passed"
