#!/usr/bin/env bash
# Probe: FEAT-G2 — task priority and ordering (Priority int on Task, priority queue)
# Fixture: tt-go
# Task type: feature
#
# Checks:
#   1. Task struct has Priority field (int, default 0)
#   2. Worker dequeues tasks in priority order (highest first)
#   3. Feature tests exist and pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

TASK_FILE="$WORKSPACE/task.go"
POOL_FILE="$WORKSPACE/pool.go"

check_file_exists "$TASK_FILE" "task.go not found in workspace"
check_file_exists "$POOL_FILE" "pool.go not found in workspace"

# ── 1. Task has Priority field ──
echo "[] Checking Task struct for Priority field..." >&2

assert_grep 'Priority[[:space:]]\+int\|Priority[[:space:]]\+.*int' "$TASK_FILE" \
    "FEAT-G2 not implemented: no Priority field on Task struct"

# ── 2. Priority ordering in queue (heap/sort usage) ──
echo "[] Checking for priority queue implementation..." >&2

if ! grep -q 'heap\|container/heap\|sort\.\|priority' "$POOL_FILE" 2>/dev/null; then
    # Check if priority ordering is in a separate file
    if ! grep -rq 'heap\|container/heap\|priority' "$WORKSPACE/"*.go 2>/dev/null; then
        fail "FEAT-G2 not implemented: no priority ordering mechanism found (heap, sort, or priority queue)"
    fi
fi

# ── 3. Feature tests exist ──
echo "[] Checking for feature tests..." >&2
check_regression_test "$WORKSPACE" "FEAT.G2\|featG2\|priority.*order\|TestPriority\|Priority.*Task" \
    "FEAT-G2: no tests found for task priority ordering"

# ── 4. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" go test -run "FEAT.G2|featG2|TestPriority|priority" ./... 2>&1; then
    fail "FEAT-G2: task priority tests failed"
fi

# ── 5. Full suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_in_workspace "$WORKSPACE" go test ./... 2>&1; then
    fail "FEAT-G2: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-G2: Priority field on Task, priority queue implementation, feature tests pass, full suite green"
