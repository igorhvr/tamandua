#!/usr/bin/env bash
# Probe: VULN-T2 — prototype pollution via Object.assign in server.ts PUT handler
# Fixture: tt-ts
# Task type: vuln (prototype pollution)
#
# Checks:
#   1. server.ts PUT handler uses safe property copy (skipping __proto__, constructor, prototype)
#   2. No Object.assign with unsanitized body

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SERVER_FILE="$WORKSPACE/src/server.ts"
check_file_exists "$SERVER_FILE" "server.ts not found in workspace"

# ── 1. Safe property copy loop (skips __proto__, constructor, prototype) ──
echo "[] Checking for safe property copy..." >&2
assert_grep "__proto__\|'constructor'\|'prototype'" "$SERVER_FILE" \
    "VULN-T2 not fixed: no safe property key filtering found in PUT handler"

# ── 2. No unsafe Object.assign with raw body ──
echo "[] Checking absence of unsafe Object.assign..." >&2
assert_not_grep 'Object\.assign.*body' "$SERVER_FILE" \
    "VULN-T2 not fixed: Object.assign with unsanitized body still present in PUT handler"

pass_ "VULN-T2: safe property copy with __proto__/constructor/prototype filtering, no raw Object.assign on body"
