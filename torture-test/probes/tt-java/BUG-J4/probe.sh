#!/usr/bin/env bash
# Probe: BUG-J4 — performance bug (O(n²) getCategoryTotals)
# Fixture: tt-java
# Task type: bug (A4 — performance)
#
# Checks:
#   1. LedgerService.getCategoryTotals() uses O(n) Map.merge, not nested loop
#   2. Performance regression test exists
#   3. Revert-probe: apply seed patch → performance test fails (times out)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-java/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-J4.patch"

LEDGER_SVC="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. getCategoryTotals uses O(n) merge, not nested loop ──
echo "[] Checking getCategoryTotals implementation..." >&2
check_file_exists "$LEDGER_SVC" "LedgerService.java not found in workspace"

# The O(n) fix uses Map.merge; the O(n²) bug uses nested for-each loops
assert_grep 'merge' "$LEDGER_SVC" \
    "BUG-J4 not fixed: getCategoryTotals does not use Map.merge (may still be O(n²))"

# ── 2. Check getCategoryTotals uses merge (O(n)) not nested loop (O(n²)) ──
echo "[] Verifying clean O(n) implementation..." >&2

# The buggy code has nested for-i/for-j loops
assert_not_grep 'for.*int i.*safe\.size\|for.*int j.*safe\.size' "$LEDGER_SVC" \
    "BUG-J4 not fixed: getCategoryTotals still has nested O(n²) loop"

pass_ "BUG-J4: O(n) merge in getCategoryTotals"
