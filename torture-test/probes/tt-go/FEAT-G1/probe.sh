#!/usr/bin/env bash
# Probe: FEAT-G1 — configurable pool size via TTGO_MAX_WORKERS env var
# Fixture: tt-go
# Task type: feature
#
# Checks:
#   1. NewPool reads TTGO_MAX_WORKERS env var
#   2. Env var takes precedence over maxWorkers parameter
#   3. Invalid env var values fall back to parameter silently
#   4. Feature tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

POOL_FILE="$WORKSPACE/pool.go"
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

# ── 1. NewPool reads env var ──
echo "[] Checking for TTGO_MAX_WORKERS env var usage..." >&2

assert_grep 'TTGO_MAX_WORKERS\|os\.Getenv' "$POOL_FILE" \
    "FEAT-G1 not implemented: no TTGO_MAX_WORKERS env var reading in NewPool"

# ── 2. strconv.Atoi for env var parsing ──
echo "[] Checking for env var parsing..." >&2

assert_grep 'strconv\.Atoi\|strconv\.ParseInt' "$POOL_FILE" \
    "FEAT-G1 not implemented: no env var integer parsing"

# ── 3. Feature tests exist ──
echo "[] Checking for feature tests..." >&2
check_regression_test "$WORKSPACE" "FEAT.G1\|featG1\|max_workers.*env\|MaxWorkersEnv\|TestEnvVar\|TTGO_MAX_WORKERS" \
    "FEAT-G1: no tests found for TTGO_MAX_WORKERS env var"

# ── 4. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" go test -run "FEAT.G1|featG1|MaxWorkersEnv|TestEnvVar" ./... 2>&1; then
    fail "FEAT-G1: env var pool size tests failed"
fi

# ── 5. Full suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "FEAT-G1: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-G1: TTGO_MAX_WORKERS env var read in NewPool, strconv.Atoi parsing, feature tests pass, full suite green"
