#!/usr/bin/env bash
# Probe: FEAT-J1 — Transaction tagging with multi-label support
# Fixture: tt-java
# Task type: feature
#
# Checks:
#   1. LedgerEntry has Set<String> tags field
#   2. CliApp supports filter --tag <name>
#   3. LedgerService has getByTag() method
#   4. Feature tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

ENTRY_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerEntry.java"
CLI_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/CliApp.java"
SVC_FILE="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. LedgerEntry has tags field ──
echo "[] Checking LedgerEntry for tags field..." >&2
check_file_exists "$ENTRY_FILE" "LedgerEntry.java not found in workspace"

assert_grep 'Set.*tags\|\btags\b.*Set\|Set.*String' "$ENTRY_FILE" \
    "FEAT-J1 not implemented: no Set<String> tags field in LedgerEntry"

# ── 2. CLI filter --tag support ──
echo "[] Checking CliApp for tag filter..." >&2
check_file_exists "$CLI_FILE" "CliApp.java not found in workspace"

if ! grep -qi 'tag' "$CLI_FILE" 2>/dev/null; then
    fail "FEAT-J1 not implemented: no tag filter in CliApp"
fi

# ── 3. LedgerService getByTag() ──
echo "[] Checking LedgerService for getByTag..." >&2
check_file_exists "$SVC_FILE" "LedgerService.java not found in workspace"

assert_grep 'getByTag\|getByTagName' "$SVC_FILE" \
    "FEAT-J1 not implemented: no getByTag method in LedgerService"

# ── 4. Feature tests exist ──
echo "[] Checking for tag-related tests..." >&2
check_regression_test "$WORKSPACE" "FEAT-J1\|getByTag\|tag.*filter\|filterByTag" \
    "FEAT-J1: no tests found for transaction tagging"

# ── 5. Run feature-specific tests ──
echo "[] Running FEAT-J1 tests..." >&2
# Look for tests with tag-related names
TAG_TESTS=$(find "$WORKSPACE/src/test" -name "*Test.java" -exec grep -l 'tag\|Tag\|FEAT.J1' {} \; 2>/dev/null)
if [ -n "$TAG_TESTS" ]; then
    for tf in $TAG_TESTS; do
        tclass=$(echo "$tf" | sed 's|.*/java/||; s|/|.|g; s|\.java$||')
        if ! (cd "$WORKSPACE" && ./mvnw -q -B test -Dtest="$tclass" 2>&1); then
            fail "FEAT-J1: tests in $tclass do not pass"
        fi
    done
fi

pass_ "FEAT-J1: Set<String> tags in LedgerEntry, CLI tag filter, getByTag in LedgerService, tests pass"
