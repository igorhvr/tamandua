#!/usr/bin/env bash
# Probe: BUG-J2 — two-module bug (null on empty CSV + NPE on null list)
# Fixture: tt-java
# Task type: bug (A2 — two-module coordinated)
#
# Checks:
#   1. CsvParser.parse() returns empty list for header-only CSV (not null)
#   2. LedgerService.getTotal() has null guard

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CSV_PARSER="$WORKSPACE/src/main/java/com/tamandua/ledger/CsvParser.java"
LEDGER_SVC="$WORKSPACE/src/main/java/com/tamandua/ledger/LedgerService.java"

# ── 1. CsvParser returns empty list for header-only CSV ──
echo "[] Checking CsvParser.parse() for header-only CSV handling..." >&2
check_file_exists "$CSV_PARSER" "CsvParser.java not found in workspace"

# The buggy code adds: if (entries.isEmpty()) { return null; } after the parsing loop
# The fixed code never returns null for empty entries — check for return null in the file
assert_not_grep 'return null' "$CSV_PARSER" \
    "BUG-J2 not fixed: CsvParser has return null (should return empty list for header-only CSV)"

# ── 2. LedgerService.getTotal() has null guard ──
echo "[] Checking LedgerService.getTotal() for null guard..." >&2
check_file_exists "$LEDGER_SVC" "LedgerService.java not found in workspace"

# The buggy code removes null guard: for (LedgerEntry e : entries)
# The fixed code has: for (LedgerEntry e : safe) where safe = (entries != null) ? entries : ...
assert_grep 'entries != null.*\?.*entries.*:\|entries.*!=.*null.*\?' "$LEDGER_SVC" \
    "BUG-J2 not fixed: LedgerService.getTotal() lacks null guard (no null check on entries)"

pass_ "BUG-J2: CsvParser returns empty list, LedgerService has null guard"
