#!/usr/bin/env bash
# Probe: POLY-BRK-T2 — broken server test assertion (POST status expects 200 instead of 201)
# Fixture: tt-poly-lite (ts/ subtree)
# Task type: broken-test
#
# Checks:
#   1. server.test.ts POST assertion expects status 201 (not 200)
#   2. Full test suite passes (0 failures in npm test)

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TEST_FILE="$WORKSPACE/ts/src/server.test.ts"
check_file_exists "$TEST_FILE" "server.test.ts not found in ts/ workspace"

# ── 1. Correct expected status in POST assertion ──
echo "[] Checking POST status assertion..." >&2

# The broken version: assert.strictEqual(status, 200) in POST test
# The fixed version: assert.strictEqual(status, 201)
# Only the POST test uses 201 — all other endpoints use 200
assert_grep 'assert\.strictEqual.*status.*201' "$TEST_FILE" \
    "POLY-BRK-T2 not fixed: POST assertion does not expect status 201"

# ── 2. Full test suite passes ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE/ts" npm test 2>&1 | grep -q "fail 0"; then
    fail "POLY-BRK-T2: test suite still has failures"
fi

pass_ "POLY-BRK-T2: POST assertion expects status 201, full test suite passes"
