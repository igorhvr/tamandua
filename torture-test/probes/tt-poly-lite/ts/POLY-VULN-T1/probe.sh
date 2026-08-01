#!/usr/bin/env bash
# Probe: POLY-VULN-T1 — XSS via unescaped description (innerHTML vs textContent)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: vuln (XSS — dormant in green baseline)
#
# Checks:
#   1. app.js uses textContent (not innerHTML) for expense description rendering
#   No revert-probe — vulnerability is dormant in green baseline, no seed patch exists.

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

APP_FILE="$WORKSPACE/ts/public/app.js"
check_file_exists "$APP_FILE" "app.js not found in ts/ workspace"

# ── 1. Must use textContent for description rendering ──
echo "[] Checking for textContent in description rendering..." >&2
assert_grep 'textContent' "$APP_FILE" \
    "POLY-VULN-T1 not fixed: textContent not found in ts/public/app.js"

# ── 2. Must NOT use innerHTML for description rendering ──
echo "[] Checking absence of innerHTML for description..." >&2
assert_not_grep 'descTd\.innerHTML\b' "$APP_FILE" \
    "POLY-VULN-T1 not fixed: description still rendered via descTd.innerHTML in ts/public/app.js"

pass_ "POLY-VULN-T1: description rendered via textContent, no innerHTML for expense descriptions"
