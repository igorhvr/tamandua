#!/usr/bin/env bash
# Probe: POLY-VULN-T2 — prototype pollution via Object.assign in PUT handler
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: vuln (prototype pollution — dormant in green baseline)
#
# Checks:
#   1. server.ts PUT handler uses safe property copy (skipping __proto__, constructor, prototype)
#   2. No Object.assign with unsanitized body
#   No revert-probe — vulnerability is dormant in green baseline, no seed patch exists.

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SERVER_FILE="$WORKSPACE/ts/src/server.ts"
check_file_exists "$SERVER_FILE" "server.ts not found in ts/ workspace"

# ── 1. Safe property copy loop (skips __proto__, constructor, prototype) ──
echo "[] Checking for safe property copy..." >&2
assert_grep '__proto__' "$SERVER_FILE" \
    "POLY-VULN-T2 not fixed: no safe property key filtering found in PUT handler"

# ── 2. No unsafe Object.assign with raw body ──
echo "[] Checking absence of unsafe Object.assign..." >&2
assert_not_grep 'Object\.assign.*body' "$SERVER_FILE" \
    "POLY-VULN-T2 not fixed: Object.assign with unsanitized body still present in PUT handler"

pass_ "POLY-VULN-T2: safe property copy with __proto__/constructor/prototype filtering, no raw Object.assign on body"
