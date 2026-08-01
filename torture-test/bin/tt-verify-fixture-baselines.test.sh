#!/usr/bin/env bash
set -euo pipefail

# tt-verify-fixture-baselines.test.sh — self-test for fixture baselines verifier
# US-007: Tests exercise the ACTUAL tt-verify-fixture-baselines binary via TEST_GOLDEN_ROOT env var.
# Covers US-001 (empty/missing golden root), US-002 (missing .git.hashes), US-003 (hash verification),
# US-004 (--expect flag), US-005 (smoke wired via --expect), US-006 (tt-poly-lite builder).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-verify-fixture-baselines"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-verify-fixture-baselines self-test (US-007: test real binary) ==="

# ── Helper: create a bare git repo with one commit on master, returns hash ─
# args: $1 = golden root dir, $2 = fixture name (without .git suffix)
create_fixture_with_hashes() {
  local golden="$1"
  local name="$2"
  local repo="$golden/${name}.git"
  local clone="$golden/tmp-clone-${name}"
  mkdir -p "$repo"
  git -C "$repo" init --bare -q
  git clone -q "$repo" "$clone" 2>/dev/null
  (
    cd "$clone"
    git checkout -b master
    GIT_AUTHOR_NAME="Test" GIT_AUTHOR_EMAIL="test@test" GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
      GIT_COMMITTER_NAME="Test" GIT_COMMITTER_EMAIL="test@test" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
      git commit --allow-empty -q -m "baseline"
    git push -q origin master 2>/dev/null
    git rev-parse HEAD
  )
}

# ── Setup: temp directory for isolated golden roots ────────────────────
TMPDIR=$(mktemp -d /tmp/tt-verify-fixture-baselines-test.XXXXXX)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# ── Test 1: missing golden root ────────────────────────────────────────
echo ""
echo "--- Test 1: missing golden root (US-001) ---"

MISSING_GOLDEN="$TMPDIR/nonexistent-golden"
output=$(TEST_GOLDEN_ROOT="$MISSING_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "missing golden root exits non-zero (got: $exit_code)"
else
  fail "missing golden root exited 0"
fi

if echo "$output" | grep -q "golden root missing"; then
  pass "stderr shows 'golden root missing' message"
else
  fail "stderr missing 'golden root missing' message"
fi

if echo "$output" | grep -qE '^\{"check":"fixture-baselines"' > /dev/null 2>&1; then
  pass "evidence JSON emitted to stdout"
else
  fail "evidence JSON missing from stdout"
fi

# ── Test 2: empty golden root (no *.git dirs) ──────────────────────────
echo ""
echo "--- Test 2: empty golden root (US-001) ---"

EMPTY_GOLDEN="$TMPDIR/empty-golden"
mkdir -p "$EMPTY_GOLDEN"
touch "$EMPTY_GOLDEN/some-file.txt"  # non-git file, should be ignored

output=$(TEST_GOLDEN_ROOT="$EMPTY_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "empty golden root exits non-zero (got: $exit_code)"
else
  fail "empty golden root exited 0 (should fail)"
fi

if echo "$output" | grep -q "zero \*\.git fixtures"; then
  pass "stderr shows 'zero *.git fixtures' message"
else
  fail "stderr missing 'zero *.git fixtures' message"
fi

# ── Test 3: fixture without .git.hashes file FAILs (US-002) ────────────
echo ""
echo "--- Test 3: fixture without .git.hashes FAILs (US-002) ---"

NO_HASHES_GOLDEN="$TMPDIR/no-hashes-golden"
mkdir -p "$NO_HASHES_GOLDEN"

# Create bare repo with commit but NO hashes file
mkdir -p "$NO_HASHES_GOLDEN/my-fixture.git"
git -C "$NO_HASHES_GOLDEN/my-fixture.git" init --bare -q
git clone -q "$NO_HASHES_GOLDEN/my-fixture.git" "$TMPDIR/tmp-clone-3" 2>/dev/null
( cd "$TMPDIR/tmp-clone-3" && \
  git checkout -b master && \
  GIT_AUTHOR_NAME="Test" GIT_AUTHOR_EMAIL="test@test" GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
    GIT_COMMITTER_NAME="Test" GIT_COMMITTER_EMAIL="test@test" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
    git commit --allow-empty -q -m "baseline" && \
  git push -q origin master 2>/dev/null )

output=$(TEST_GOLDEN_ROOT="$NO_HASHES_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "fixture without .git.hashes causes non-zero exit (got: $exit_code)"
else
  fail "fixture without .git.hashes did not cause non-zero exit"
fi

if echo "$output" | jq -e '.result == "FAIL"' > /dev/null 2>&1; then
  pass "evidence shows result=FAIL"
else
  fail "evidence does not show result=FAIL"
fi

if echo "$output" | jq -e '.failed == 1' > /dev/null 2>&1; then
  pass "evidence shows failed=1"
else
  fail "evidence does not show failed=1"
fi

if echo "$output" | jq -e '.fixtures[0].error | contains("missing determinism record")' > /dev/null 2>&1; then
  pass "fixture evidence has error with 'missing determinism record'"
else
  fail "fixture evidence missing determinism record error"
fi

if echo "$output" | jq -e '.fixtures[0].error | contains("fixtures-src/my-fixture/build-golden.sh")' > /dev/null 2>&1; then
  pass "remedy message names correct builder (my-fixture)"
else
  fail "remedy message missing builder path"
fi

# ── Test 4: healthy root — fixture with correct .git.hashes PASSes (US-003) ─
echo ""
echo "--- Test 4: healthy root — fixture with correct .git.hashes PASSes (US-003) ---"

HEALTHY_GOLDEN="$TMPDIR/healthy-golden"
HASH=$(create_fixture_with_hashes "$HEALTHY_GOLDEN" healthy)
echo "master $HASH" > "$HEALTHY_GOLDEN/healthy.git.hashes"

output=$(TEST_GOLDEN_ROOT="$HEALTHY_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  pass "healthy fixture with correct .git.hashes exits 0"
else
  fail "healthy fixture exited $exit_code (expected 0)"
fi

if echo "$output" | jq -e '.result == "PASS"' > /dev/null 2>&1; then
  pass "evidence shows result=PASS"
else
  fail "evidence does not show result=PASS"
fi

if echo "$output" | jq -e '.passed == 1' > /dev/null 2>&1; then
  pass "evidence shows passed=1"
else
  fail "evidence does not show passed=1"
fi

if echo "$output" | jq -e '.failed == 0' > /dev/null 2>&1; then
  pass "evidence shows failed=0"
else
  fail "evidence does not show failed=0"
fi

# US-003: hash_check evidence
if echo "$output" | jq -e '.fixtures[0].hash_check.passed == true' > /dev/null 2>&1; then
  pass "hash_check.passed is true"
else
  fail "hash_check.passed is not true"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.total == 1' > /dev/null 2>&1; then
  pass "hash_check.total is 1"
else
  fail "hash_check.total is not 1"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.matched == 1' > /dev/null 2>&1; then
  pass "hash_check.matched is 1"
else
  fail "hash_check.matched is not 1"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures == []' > /dev/null 2>&1; then
  pass "hash_check.failures is empty"
else
  fail "hash_check.failures is not empty"
fi

# US-003: verify evidence includes bare/HEAD fields
if echo "$output" | jq -e '.fixtures[0].default_branch' > /dev/null 2>&1; then
  pass "evidence includes default_branch"
else
  fail "evidence missing default_branch"
fi

if echo "$output" | jq -e '.fixtures[0].head' > /dev/null 2>&1; then
  pass "evidence includes head commit hash"
else
  fail "evidence missing head"
fi

# ── Test 5: fixture with .git.hashes but not a bare repo FAILs ────────
echo ""
echo "--- Test 5: fixture with .git.hashes but not a bare repo FAILs ---"

BROKEN_GOLDEN="$TMPDIR/broken-golden"
mkdir -p "$BROKEN_GOLDEN"
mkdir "$BROKEN_GOLDEN/broken.git"  # not a git repo, just a plain directory
echo "master fakehash" > "$BROKEN_GOLDEN/broken.git.hashes"

output=$(TEST_GOLDEN_ROOT="$BROKEN_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "fixture with .hashes but not a bare repo FAILs (got: $exit_code)"
else
  fail "fixture with .hashes but not a bare repo PASSed (expected FAIL)"
fi

if echo "$output" | jq -e '.fixtures[0].result == "FAIL"' > /dev/null 2>&1; then
  pass "broken bare fixture shows result=FAIL"
else
  fail "broken bare fixture result is not FAIL"
fi

# ── Test 8: unresolvable ref in .git.hashes FAILs (US-003) ────────────
echo ""
echo "--- Test 8: unresolvable ref in .git.hashes FAILs (US-003) ---"

NO_REF_GOLDEN="$TMPDIR/no-ref-golden"
HASH=$(create_fixture_with_hashes "$NO_REF_GOLDEN" unresolved)

# Non-existent ref name (even though hash is correct for master)
echo "NONEXISTENT_REF deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$NO_REF_GOLDEN/unresolved.git.hashes"

output=$(TEST_GOLDEN_ROOT="$NO_REF_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "unresolvable ref causes non-zero exit (got: $exit_code)"
else
  fail "unresolvable ref did not cause non-zero exit"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.passed == false' > /dev/null 2>&1; then
  pass "hash_check.passed is false"
else
  fail "hash_check.passed is not false"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].key == "NONEXISTENT_REF"' > /dev/null 2>&1; then
  pass "failure includes key NONEXISTENT_REF"
else
  fail "failure missing key NONEXISTENT_REF"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].error | contains("ref not found")' > /dev/null 2>&1; then
  pass "failure shows 'ref not found' error"
else
  fail "failure missing 'ref not found' error"
fi

# ── Test 9: mismatched hash in .git.hashes FAILs (US-003) ─────────────
echo ""
echo "--- Test 9: mismatched hash FAILs (US-003) ---"

MISMATCH_GOLDEN="$TMPDIR/mismatch-golden"
HASH=$(create_fixture_with_hashes "$MISMATCH_GOLDEN" mismatch)

# Resolvable key but WRONG hash
echo "master deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$MISMATCH_GOLDEN/mismatch.git.hashes"

output=$(TEST_GOLDEN_ROOT="$MISMATCH_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "mismatched hash causes non-zero exit (got: $exit_code)"
else
  fail "mismatched hash did not cause non-zero exit"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].error == "hash mismatch"' > /dev/null 2>&1; then
  pass "failure shows 'hash mismatch'"
else
  fail "failure missing 'hash mismatch' error"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].expected' > /dev/null 2>&1; then
  pass "failure includes expected hash"
else
  fail "failure missing expected hash"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].actual' > /dev/null 2>&1; then
  pass "failure includes actual hash"
else
  fail "failure missing actual hash"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.failures[0].actual != .fixtures[0].hash_check.failures[0].expected' > /dev/null 2>&1; then
  pass "expected and actual hash differ"
else
  fail "expected and actual hash are same (should differ)"
fi

# ── Test 10: blank lines and #-comments in .git.hashes ignored (US-003) ─
echo ""
echo "--- Test 10: blank lines and #-comments ignored (US-003) ---"

COMMENT_GOLDEN="$TMPDIR/comment-golden"
HASH=$(create_fixture_with_hashes "$COMMENT_GOLDEN" comment)

# Hashes file with blank lines and comments
cat > "$COMMENT_GOLDEN/comment.git.hashes" << EOF
# This is a comment

master $HASH

# Another comment with extra info

EOF

output=$(TEST_GOLDEN_ROOT="$COMMENT_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  pass "fixture with comments/blank lines PASSes (exit 0)"
else
  fail "fixture with comments/blank lines exited $exit_code"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.total == 1' > /dev/null 2>&1; then
  pass "hash_check.total is 1 (blank lines and comments ignored)"
else
  fail "hash_check.total is not 1"
fi

if echo "$output" | jq -e '.fixtures[0].hash_check.matched == 1' > /dev/null 2>&1; then
  pass "hash_check.matched is 1 (the one real entry matched)"
else
  fail "hash_check.matched is not 1"
fi

# ── Test 11: --expect with all present fixtures passes (US-004) ───────
echo ""
echo "--- Test 11: --expect with all present fixtures passes (US-004) ---"

EXPECT_ALL_GOLDEN="$TMPDIR/expect-all-golden"
mkdir -p "$EXPECT_ALL_GOLDEN"

for name in alpha beta; do
  HASH=$(create_fixture_with_hashes "$EXPECT_ALL_GOLDEN" "$name")
  echo "master $HASH" > "$EXPECT_ALL_GOLDEN/${name}.git.hashes"
done

output=$(TEST_GOLDEN_ROOT="$EXPECT_ALL_GOLDEN" "$TOOL" --expect alpha,beta 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  pass "--expect alpha,beta with both present exits 0"
else
  fail "--expect alpha,beta with both present exited $exit_code"
fi

if echo "$output" | jq -e '.result == "PASS"' > /dev/null 2>&1; then
  pass "--expect: evidence result=PASS"
else
  fail "--expect: evidence result not PASS"
fi

if echo "$output" | jq -e '.expected == ["alpha","beta"]' > /dev/null 2>&1; then
  pass "--expect: evidence.expected present and correct"
else
  fail "--expect: evidence.expected missing or wrong"
fi

# ── Test 12: --expect with a missing fixture FAILs (US-004) ───────────
echo ""
echo "--- Test 12: --expect with a missing fixture FAILs (US-004) ---"

output=$(TEST_GOLDEN_ROOT="$EXPECT_ALL_GOLDEN" "$TOOL" --expect alpha,nonexistent,beta 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "--expect with nonexistent fixture exits non-zero (got: $exit_code)"
else
  fail "--expect with nonexistent fixture exited 0"
fi

if echo "$output" | grep -qE '"absent":\["nonexistent"\]' > /dev/null 2>&1; then
  pass "--expect: evidence.absent lists nonexistent"
else
  fail "--expect: evidence.absent wrong or missing"
fi

if echo "$output" | grep -q "expected fixtures not found" 2>/dev/null; then
  pass "--expect: stderr shows 'expected fixtures not found'"
else
  fail "--expect: stderr missing 'expected fixtures not found'"
fi

# ── Test 13: without --expect, only discovered fixtures checked (US-004) ─
echo ""
echo "--- Test 13: without --expect, only discovered fixtures checked (US-004) ---"

ONLY_ONE_GOLDEN="$TMPDIR/only-one-golden"
mkdir -p "$ONLY_ONE_GOLDEN"
HASH=$(create_fixture_with_hashes "$ONLY_ONE_GOLDEN" alpha)
echo "master $HASH" > "$ONLY_ONE_GOLDEN/alpha.git.hashes"

output=$(TEST_GOLDEN_ROOT="$ONLY_ONE_GOLDEN" "$TOOL" 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  pass "without --expect, single fixture present exits 0"
else
  fail "without --expect, single fixture present exited $exit_code"
fi

if echo "$output" | jq -e '.total == 1' > /dev/null 2>&1; then
  pass "without --expect: only discovered fixture checked (total=1)"
else
  fail "without --expect: total not 1"
fi

if echo "$output" | jq -e 'has("expected") | not' > /dev/null 2>&1; then
  pass "without --expect: evidence does NOT include expected field"
else
  fail "without --expect: evidence unexpectedly includes expected field"
fi

# ── Test 14: --help outputs usage documentation ───────────────────────
echo ""
echo "--- Test 14: --help outputs usage documentation ---"

output=$(TEST_GOLDEN_ROOT="$EMPTY_GOLDEN" "$TOOL" --help 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  pass "--help exits 0"
else
  fail "--help exited $exit_code"
fi

if echo "$output" | grep -q "Usage:"; then
  pass "--help shows Usage: line"
else
  fail "--help missing Usage: line"
fi

if echo "$output" | grep -q -- "--expect"; then
  pass "--help documents --expect flag"
else
  fail "--help does not document --expect flag"
fi

# ── Test 15: --expect without a value fails ───────────────────────────
echo ""
echo "--- Test 15: --expect without a value fails with clear error ---"

output=$(TEST_GOLDEN_ROOT="$EMPTY_GOLDEN" "$TOOL" --expect 2>&1) && exit_code=$? || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  pass "--expect without value exits non-zero (got: $exit_code)"
else
  fail "--expect without value exited 0"
fi

if echo "$output" | grep -q "requires"; then
  pass "--expect without value shows requirement message"
else
  fail "--expect without value missing requirement message"
fi

# ── Test 6: real verifier with actual golden root ─────────────────────
echo ""
echo "--- Test 6: real verifier (smoke) ---"

if [ -z "${TEST_GOLDEN_ROOT:-}" ]; then
  REAL_GOLDEN="$SCRIPT_DIR/../var/fixtures/golden"
  if [ -d "$REAL_GOLDEN" ] && [ -n "$(ls -A "$REAL_GOLDEN"/*.git 2>/dev/null)" ]; then
    output=$("$TOOL" 2>&1) && exit_code=$? || exit_code=$?
    echo "  Real verifier exit code: $exit_code"
    if echo "$output" | jq . > /dev/null 2>&1; then
      pass "real verifier outputs valid JSON"
    else
      fail "real verifier output is not valid JSON"
    fi
  else
    echo "  SKIP: no real golden root with *.git fixtures"
  fi
else
  echo "  SKIP: TEST_GOLDEN_ROOT is set (running in test harness)"
fi

# ── Test 7: deterministic re-runs ─────────────────────────────────────
echo ""
echo "--- Test 7: deterministic re-runs ---"

run1_out=$(TEST_GOLDEN_ROOT="$NO_HASHES_GOLDEN" "$TOOL" 2>&1) && run1_exit=$? || run1_exit=$?
run2_out=$(TEST_GOLDEN_ROOT="$NO_HASHES_GOLDEN" "$TOOL" 2>&1) && run2_exit=$? || run2_exit=$?

if [ "$run1_exit" = "$run2_exit" ]; then
  pass "exit codes match across two runs ($run1_exit = $run2_exit)"
else
  fail "exit codes differ across runs ($run1_exit vs $run2_exit)"
fi

if [ "$run1_out" = "$run2_out" ]; then
  pass "JSON outputs are identical across two runs"
else
  fail "JSON outputs differ across two runs"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "========================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "RESULT: All tests PASSED"
  exit 0
else
  echo "RESULT: $FAILURES test(s) FAILED"
  exit 1
fi
