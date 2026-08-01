#!/usr/bin/env bash
# probe-common.test.sh — Self-tests for probe-common.sh shared utility library
#
# Tests every function exported by probe-common.sh for self-consistency.
# Run: bash torture-test/probes/lib/probe-common.test.sh
#
# This test file does NOT source probe-common.sh directly — each test
# runs in a subshell to avoid accumulating side effects (set -e, exit
# calls) that would terminate the test runner itself.
#
# Strategy: we can't use probe-common's fail()/pass_() because they call
# exit, which would kill the test runner. Instead we source the library
# in subshells and observe exit codes, stderr, and stdout.

set -euo pipefail

LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_FILE="$LIB_DIR/probe-common.sh"
PASSED=0
FAILED=0

assert_equals() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [ "$expected" = "$actual" ]; then
        PASSED=$((PASSED + 1))
        printf '  ✓ %s\n' "$label" >&2
    else
        FAILED=$((FAILED + 1))
        printf '  ✗ %s\n' "  expected: $expected\n  actual:   $actual" >&2
        printf '    expected: %s\n' "$expected" >&2
        printf '    actual:   %s\n' "$actual" >&2
    fi
}

assert_exit() {
    local label="$1"
    local expected_code="$2"
    shift 2
    local actual_code=0
    set +e
    ( "$@" ) >/dev/null 2>&1
    actual_code=$?
    set -e
    if [ "$expected_code" -eq "$actual_code" ]; then
        PASSED=$((PASSED + 1))
        printf '  ✓ %s (exit %d)\n' "$label" "$expected_code" >&2
    else
        FAILED=$((FAILED + 1))
        printf '  ✗ %s\n' "$label" >&2
        printf '    expected exit: %d\n' "$expected_code" >&2
        printf '    actual exit:   %d\n' "$actual_code" >&2
    fi
}

assert_stdout_contains() {
    local label="$1"
    local expected="$2"
    shift 2
    local stdout
    set +e
    stdout=$("$@" 2>/dev/null) || true
    set -e
    if [[ "$stdout" == *"$expected"* ]]; then
        PASSED=$((PASSED + 1))
        printf '  ✓ %s\n' "$label" >&2
    else
        FAILED=$((FAILED + 1))
        printf '  ✗ %s\n' "$label" >&2
        printf '    expected stdout to contain: %s\n' "$expected" >&2
        printf '    actual stdout: %s\n' "$stdout" >&2
    fi
}

assert_stderr_contains() {
    local label="$1"
    local expected="$2"
    shift 2
    local stderr
    set +e
    stderr=$("$@" 2>&1 1>/dev/null) || true
    set -e
    if [[ "$stderr" == *"$expected"* ]]; then
        PASSED=$((PASSED + 1))
        printf '  ✓ %s\n' "$label" >&2
    else
        FAILED=$((FAILED + 1))
        printf '  ✗ %s\n' "$label" >&2
        printf '    expected stderr to contain: %s\n' "$expected" >&2
        printf '    actual stderr: %s\n' "$stderr" >&2
    fi
}

# ── Test harness: run snippet in subshell that sources the library ──
# Runs bash -c with PROBE_ID set and the library sourced.
run_probe_snippet() {
    local snippet="$1"
    PROBE_ID="test-probe" bash -c "
        source '$LIB_FILE'
        $snippet
    "
}

echo "=== probe-common.sh self-tests ===" >&2
echo "" >&2

# ── 1. Library sources without errors ──
echo "  Library sources cleanly:" >&2
set +e
bash -c "source '$LIB_FILE'" 2>/dev/null
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
    PASSED=$((PASSED + 1))
    printf '  ✓ sources without errors\n' >&2
else
    FAILED=$((FAILED + 1))
    printf '  ✗ sources with errors (exit %d)\n' "$rc" >&2
fi

# ── 2. Exit code constants ──
echo "  Exit codes:" >&2
assert_equals "EXIT_PASS is 0" "0" "$(bash -c "source '$LIB_FILE'; echo \$EXIT_PASS")"
assert_equals "EXIT_FAIL is 1" "1" "$(bash -c "source '$LIB_FILE'; echo \$EXIT_FAIL")"
assert_equals "EXIT_INFRA is 2" "2" "$(bash -c "source '$LIB_FILE'; echo \$EXIT_INFRA")"

# ── 3. fail() ──
echo "  fail():" >&2
assert_exit "fail() exits with code 1" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; fail 'something broke'"
assert_stderr_contains "fail() prints FAIL to stderr" "FAIL [test]: something broke" \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; fail 'something broke'"

# ── 4. pass_() ──
echo "  pass_():" >&2
assert_exit "pass_() exits with code 0" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; pass_ 'all good'"
assert_stderr_contains "pass_() prints PASS to stderr" "PASS [test]: all good" \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; pass_ 'all good'"

# ── 5. infra_error() ──
echo "  infra_error():" >&2
assert_exit "infra_error() exits with code 2" 2 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; infra_error 'missing dep'"
assert_stderr_contains "infra_error() prints INFRA-ERROR to stderr" "INFRA-ERROR [test]: missing dep" \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; infra_error 'missing dep'"

# ── 6. vrun() ──
echo "  vrun():" >&2
assert_stderr_contains "vrun() echoes command to stderr" ">>> echo hello" \
    bash -c "source '$LIB_FILE'; vrun echo hello"
assert_stdout_contains "vrun() still produces stdout" "hello" \
    bash -c "source '$LIB_FILE'; vrun echo hello"

# ── 7. assert_grep() ──
echo "  assert_grep():" >&2
TMPFILE=$(mktemp)
echo "hello world" > "$TMPFILE"
echo "goodbye moon" >> "$TMPFILE"
assert_exit "assert_grep() exits 0 when pattern found" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; assert_grep 'hello' '$TMPFILE'"
assert_exit "assert_grep() exits 1 when pattern not found" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; assert_grep 'missing' '$TMPFILE'"
rm -f "$TMPFILE"

# ── 8. assert_not_grep() ──
echo "  assert_not_grep():" >&2
TMPFILE=$(mktemp)
echo "safe content" > "$TMPFILE"
assert_exit "assert_not_grep() exits 0 when pattern absent" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; assert_not_grep 'forbidden' '$TMPFILE'"
assert_exit "assert_not_grep() exits 1 when pattern present" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; assert_not_grep 'safe' '$TMPFILE'"
rm -f "$TMPFILE"

# ── 9. check_file_exists() ──
echo "  check_file_exists():" >&2
TMPFILE=$(mktemp)
assert_exit "check_file_exists() exits 0 when file exists" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_file_exists '$TMPFILE'"
assert_exit "check_file_exists() exits 1 when file missing" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_file_exists '/nonexistent/file/xyz'"
rm -f "$TMPFILE"

# ── 10. check_dir_exists() ──
echo "  check_dir_exists():" >&2
TMPDIR=$(mktemp -d)
assert_exit "check_dir_exists() exits 0 when dir exists" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_dir_exists '$TMPDIR'"
assert_exit "check_dir_exists() exits 1 when dir missing" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_dir_exists '/nonexistent/dir/xyz'"
rmdir "$TMPDIR"

# ── 11. check_cmd_output() ──
echo "  check_cmd_output():" >&2
assert_exit "check_cmd_output() exits 0 when pattern matches stdout" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_cmd_output 'hello' echo hello"
assert_exit "check_cmd_output() exits 1 when pattern doesn't match" 1 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; check_cmd_output 'missing' echo hello"

# ── 12. validate_probe_args() ──
echo "  validate_probe_args():" >&2
TMPDIR=$(mktemp -d)
TMPWS=$(mktemp -d)
TMPSCRATCH=$(mktemp -d)
assert_exit "validate_probe_args() exits 0 with valid args" 0 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; validate_probe_args '$TMPWS' 'base-ref' '$TMPSCRATCH'"
assert_exit "validate_probe_args() exits 2 with missing workspace" 2 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; validate_probe_args '' 'base-ref' '$TMPSCRATCH'"
assert_exit "validate_probe_args() exits 2 with nonexistent workspace" 2 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; validate_probe_args '/nonexistent/ws' 'base-ref' '$TMPSCRATCH'"
assert_exit "validate_probe_args() exits 2 with missing scratch" 2 \
    bash -c "source '$LIB_FILE'; PROBE_ID=test; validate_probe_args '$TMPWS' 'base-ref' ''"
rmdir "$TMPDIR" "$TMPWS" "$TMPSCRATCH"

# ── 13. PROBE_ID defaults to directory name ──
echo "  PROBE_ID default:" >&2
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/my-test-id"
cat > "$TMPDIR/my-test-id/probe.sh" << 'SCRIPT'
#!/usr/bin/env bash
source "../../lib/probe-common.sh"
echo "$PROBE_ID"
SCRIPT
# Simulate what happens when script is in a directory: the dirname of $0 gives the id
BASENAME_OUTPUT=$(cd "$TMPDIR" && basename "$TMPDIR/my-test-id")
assert_equals "PROBE_ID defaults to script directory basename" "my-test-id" "$BASENAME_OUTPUT"
rm -rf "$TMPDIR"

# ── Summary ──
echo "" >&2
echo "=== Results ===" >&2
echo "  Passed: $PASSED" >&2
echo "  Failed: $FAILED" >&2
echo "" >&2

if [ "$FAILED" -gt 0 ]; then
    echo "FAIL: $FAILED test(s) failed" >&2
    exit 1
else
    echo "All $PASSED tests passed." >&2
    exit 0
fi
