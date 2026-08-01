#!/usr/bin/env bash
# Probe: FEAT-G3 — task retry with exponential backoff
# Fixture: tt-go
# Task type: feature
#
# Checks:
#   1. Task struct has MaxRetries and Backoff fields
#   2. Worker retries failed tasks up to MaxRetries times
#   3. Exponential backoff: Backoff × 2^retry
#   4. Panicked tasks are NOT retried
#   5. Feature tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TASK_FILE="$WORKSPACE/task.go"
WORKER_FILE="$WORKSPACE/worker.go"

check_file_exists "$TASK_FILE" "task.go not found in workspace"
check_file_exists "$WORKER_FILE" "worker.go not found in workspace"

# ── 1. Task has MaxRetries and Backoff fields ──
echo "[] Checking Task struct for retry fields..." >&2

assert_grep 'MaxRetries[[:space:]]\+int\|MaxRetries[[:space:]]\+.*int' "$TASK_FILE" \
    "FEAT-G3 not implemented: no MaxRetries field on Task struct"

assert_grep 'Backoff[[:space:]]\+.*Duration\|Backoff[[:space:]]\+time\.Duration' "$TASK_FILE" \
    "FEAT-G3 not implemented: no Backoff field on Task struct"

# ── 2. Worker implements retry logic ──
echo "[] Checking worker for retry logic..." >&2

assert_grep 'MaxRetries\|Backoff\|retry\|retries' "$WORKER_FILE" \
    "FEAT-G3 not implemented: no retry logic in worker"

# ── 3. Exponential backoff (2^retry factor) ──
echo "[] Checking for exponential backoff..." >&2

# Search for backoff multiplication pattern in worker or pool files
if ! grep -rq 'Backoff.*\*\|backoff.*\*\|<<.*retry\|math\.Pow\|time\.Sleep.*backoff\|time\.Sleep.*retry' "$WORKSPACE/"*.go 2>/dev/null; then
    fail "FEAT-G3 not implemented: no exponential backoff calculation found"
fi

# ── 4. Panic recovery does NOT retry ──
echo "[] Checking panic recovery bypasses retry..." >&2

assert_grep 'panic\|PanicError\|recover' "$WORKER_FILE" \
    "FEAT-G3: worker.go does not reference panic recovery (must not retry panics)"

# ── 5. Feature tests exist ──
echo "[] Checking for feature tests..." >&2
check_regression_test "$WORKSPACE" "FEAT.G3\|featG3\|retry.*backoff\|TestRetry\|MaxRetries" \
    "FEAT-G3: no tests found for task retry with backoff"

# ── 6. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" go test -run "FEAT.G3|featG3|TestRetry|retry.*backoff|MaxRetries" ./... 2>&1; then
    fail "FEAT-G3: retry with backoff tests failed"
fi

# ── 7. Full suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "FEAT-G3: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-G3: MaxRetries+Backoff on Task, exponential backoff in worker, panic bypasses retry, feature tests pass, full suite green"
