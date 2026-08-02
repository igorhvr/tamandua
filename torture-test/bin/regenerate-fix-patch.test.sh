#!/usr/bin/env bash
# regenerate-fix-patch.test.sh — Self-test for regenerate-fix-patch.sh
#
# Exercises: help output, fix patch generation for single-lang fixtures,
# monorepo --cwd handling, patch validity verification, and error handling.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/regenerate-fix-patch.sh"
TMPDIR="${TMPDIR:-/tmp}"

FAILURES=0
PASSES=0
TEST_VAR=""

pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
    if [ -n "${TEST_VAR:-}" ] && [ -d "$TEST_VAR" ]; then
        rm -rf "$TEST_VAR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ── Setup: create a minimal golden bare repo with test content ──────
setup_single_lang_golden() {
    TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-fix-test-XXXXXX")

    # Build a bare repo from scratch
    local work
    work=$(mktemp -d "${TMPDIR}/regenerate-work-XXXXXX")
    (
        cd "$work"
        git init --initial-branch=main > /dev/null 2>&1
        git config user.email "test@fixtures.invalid"
        git config user.name "Test Fixture"

        # Create source files
        echo 'package main

import "testing"

func TestAdd(t *testing.T) {
    result := add(2, 3)
    if result != 5 {
        t.Errorf("expected 5, got %d", result)
    }
}

func TestMul(t *testing.T) {
    result := mul(2, 3)
    if result != 6 {
        t.Errorf("expected 6, got %d", result)
    }
}' > math_test.go

        echo 'package main

func add(a, b int) int {
    return a + b
}

func mul(a, b int) int {
    return a * b
}' > math.go

        git add -A
        git commit -q -m "Initial baseline"
    )

    # Create bare repo
    local bare="${TEST_VAR}/test-fixture.git"
    git init --bare "$bare" > /dev/null 2>&1
    (
        cd "$work"
        git push "$bare" HEAD:refs/heads/main > /dev/null 2>&1
    )
    git --git-dir="$bare" symbolic-ref HEAD refs/heads/main

    rm -rf "$work"

    # Create a seed overlay directory (BUG-1: broken add function)
    local seed_dir="${TEST_VAR}/seeds/BUG-1"
    mkdir -p "$seed_dir"

    echo 'package main

func add(a, b int) int {
    return a - b  // BUG: subtraction instead of addition
}

func mul(a, b int) int {
    return a * b
}' > "$seed_dir/math.go"

    # Create a fix.patch (current — will be regenerated)
    echo 'dummy-corrupt-patch' > "$seed_dir/fix.patch"

    echo "$TEST_VAR"
}

# ── Setup: create a monorepo-style golden bare ──────────────────────
setup_monorepo_golden() {
    TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-mono-test-XXXXXX")

    local work
    work=$(mktemp -d "${TMPDIR}/regenerate-mono-work-XXXXXX")
    (
        cd "$work"
        git init --initial-branch=main > /dev/null 2>&1
        git config user.email "test@fixtures.invalid"
        git config user.name "Test Fixture"

        # python/ subtree
        mkdir -p python/src/lib

        echo 'def compute(a, b):
    return a + b

def broken_compute(a, b):
    return a - b  # BUG
' > python/src/lib/math.py

        # ts/ subtree  
        mkdir -p ts/src

        echo 'export function compute(a: number, b: number): number {
    return a + b;
}

export function brokenCompute(a: number, b: number): number {
    return a - b; // BUG
}' > ts/src/math.ts

        git add -A
        git commit -q -m "Initial baseline: monorepo"
    )

    local bare="${TEST_VAR}/poly-fixture.git"
    git init --bare "$bare" > /dev/null 2>&1
    (
        cd "$work"
        git push "$bare" HEAD:refs/heads/main > /dev/null 2>&1
    )
    git --git-dir="$bare" symbolic-ref HEAD refs/heads/main

    rm -rf "$work"

    # Seed overlay for python BUG
    local seed_dir="${TEST_VAR}/python-seeds/POLY-BUG-1"
    mkdir -p "$seed_dir"

    echo 'def compute(a, b):
    return a + b

def broken_compute(a, b):
    return a + b  # FIXED: was a - b
' > "$seed_dir/math.py"

    echo "$TEST_VAR"
}

echo "=== regenerate-fix-patch.sh self-test ==="
echo ""

# ── Test 1: --help output ──────────────────────────────────────────

echo "--- Test: --help ---"

if "$TOOL" --help 2>&1 | grep -q "Usage:"; then
    pass "--help prints usage"
else
    fail "--help did not print usage"
fi

if "$TOOL" --help > /dev/null 2>&1; then
    pass "--help exits 0"
else
    fail "--help did not exit 0"
fi

if "$TOOL" -h 2>&1 | grep -q "Usage:"; then
    pass "-h prints usage (short form)"
else
    fail "-h did not print usage"
fi

echo ""
echo "--- Test: --help content ---"

help_out="$("$TOOL" --help 2>&1)"

if echo "$help_out" | grep -q "golden-bare"; then
    pass "--help documents golden-bare argument"
else
    fail "--help missing golden-bare docs"
fi

if echo "$help_out" | grep -q "seed-dir"; then
    pass "--help documents seed-dir argument"
else
    fail "--help missing seed-dir docs"
fi

if echo "$help_out" | grep -q "fix-patch-output"; then
    pass "--help documents fix-patch-output argument"
else
    fail "--help missing fix-patch-output docs"
fi

if echo "$help_out" | grep -q "\-\-cwd"; then
    pass "--help documents --cwd option"
else
    fail "--help missing --cwd option docs"
fi

# ── Test 2: Missing arguments error ─────────────────────────────────

echo ""
echo "--- Test: missing arguments ---"

set +e
OUT=$("$TOOL" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "Missing args exits 2"
else
    fail "Missing args should exit 2, got $RC"
fi

if echo "$OUT" | grep -qi "missing\|required"; then
    pass "Missing args produces clear error message"
else
    fail "Missing args should mention missing/required arguments"
fi

# ── Test 3: Non-existent golden bare ────────────────────────────────

echo ""
echo "--- Test: non-existent golden bare ---"

set +e
OUT=$("$TOOL" "/nonexistent/path.git" "/tmp/seed" "/tmp/output" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "Non-existent golden bare exits 1"
else
    fail "Non-existent golden bare should exit 1, got $RC"
fi

if echo "$OUT" | grep -qi "not found"; then
    pass "Non-existent golden bare produces 'not found' message"
else
    fail "Non-existent golden bare missing error message"
fi

# ── Test 4: Non-existent seed directory ─────────────────────────────

echo ""
echo "--- Test: non-existent seed directory ---"

# We need a valid golden bare first; reuse setup from later test
TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-err-test-XXXXXX")
TEST_BARE="${TEST_VAR}/test-fixture.git"
mkdir -p "$TEST_BARE"

set +e
OUT=$("$TOOL" "$TEST_BARE" "/nonexistent/seed/dir" "/tmp/output" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "Non-existent seed dir exits 1"
else
    fail "Non-existent seed dir should exit 1, got $RC"
fi

rm -rf "$TEST_VAR"
TEST_VAR=""

# ── Test 5: Single-language fix patch generation ────────────────────

echo ""
echo "--- Test: single-language fix patch generation ---"

setup_single_lang_golden

GOLDEN_BARE="${TEST_VAR}/test-fixture.git"
SEED_DIR="${TEST_VAR}/seeds/BUG-1"
OUTPUT_PATCH="${TEST_VAR}/generated-fix.patch"

"$TOOL" "$GOLDEN_BARE" "$SEED_DIR" "$OUTPUT_PATCH"

if [ -f "$OUTPUT_PATCH" ] && [ -s "$OUTPUT_PATCH" ]; then
    pass "Generated fix patch exists and is non-empty"
else
    fail "Generated fix patch missing or empty"
fi

# Verify patch content — should contain diff hunks for math.go
if grep -q "return a - b" "$OUTPUT_PATCH"; then
    pass "Patch contains original buggy line (removal)"
else
    fail "Patch missing original buggy line"
fi

if grep -q "return a + b" "$OUTPUT_PATCH"; then
    pass "Patch contains fixed line (addition)"
else
    fail "Patch missing fixed line"
fi

# Verify hunk header format: should have proper @@ lines
if grep -q '^@@ -[0-9]' "$OUTPUT_PATCH"; then
    pass "Patch has proper hunk headers (@@ -N,N +N,N @@)"
else
    fail "Patch missing hunk headers"
fi

# Verify patch applies cleanly on a SEEDED clone (seed applied first,
# then fix patch restores green). This mirrors the three-arm harness
# where Arm 2 applies seed then fix.
CLONE_DIR="$(mktemp -d "${TMPDIR}/regenerate-apply-test-XXXXXX")"
git clone -q "$GOLDEN_BARE" "$CLONE_DIR" 2>/dev/null

# Apply seed overlay to introduce the bug
for f in "$SEED_DIR"/*; do
    [ -f "$f" ] || continue
    bn="$(basename "$f")"
    case "$bn" in fix.patch|SEEDS.md|.gitkeep) continue ;; esac
    dest=$(find "$CLONE_DIR" -type f -name "$bn" -not -path '*/.git/*' 2>/dev/null | head -1)
    [ -n "$dest" ] && cp "$f" "$dest"
done

if (cd "$CLONE_DIR" && git apply --check "$OUTPUT_PATCH" 2>&1); then
    pass "Generated patch passes git apply --check on seeded clone"
else
    fail "Generated patch FAILS git apply --check on seeded clone"
fi

rm -rf "$CLONE_DIR"

# ── Test 6: Patch actually applies (full apply test on seeded clone) ─

echo ""
echo "--- Test: patch full application on seeded clone ---"

CLONE_DIR="$(mktemp -d "${TMPDIR}/regenerate-full-test-XXXXXX")"
git clone -q "$GOLDEN_BARE" "$CLONE_DIR" 2>/dev/null

# Apply seed overlay to introduce the bug
for f in "$SEED_DIR"/*; do
    [ -f "$f" ] || continue
    bn="$(basename "$f")"
    case "$bn" in fix.patch|SEEDS.md|.gitkeep) continue ;; esac
    dest=$(find "$CLONE_DIR" -type f -name "$bn" -not -path '*/.git/*' 2>/dev/null | head -1)
    [ -n "$dest" ] && cp "$f" "$dest"
done

if (cd "$CLONE_DIR" && git apply "$OUTPUT_PATCH" 2>&1); then
    pass "Generated patch applies successfully (git apply)"
else
    fail "Generated patch FAILS to apply (git apply)"
fi

# Verify the fix was actually applied — math.go should now have "return a + b"
if grep -q "return a + b" "$CLONE_DIR/math.go"; then
    pass "Applied patch correctly fixes the bug"
else
    fail "Applied patch did not fix the bug"
fi

if ! grep -q "return a - b" "$CLONE_DIR/math.go"; then
    pass "Buggy subtraction line removed after patch"
else
    fail "Buggy subtraction line still present after patch"
fi

rm -rf "$CLONE_DIR"

# ── Test 7: Empty seed directory (no overlay files) ────────────────

echo ""
echo "--- Test: empty seed directory ---"

EMPTY_SEED="${TEST_VAR}/seeds/EMPTY-1"
mkdir -p "$EMPTY_SEED"
touch "$EMPTY_SEED/fix.patch"  # only fix.patch, no overlay files

set +e
OUT=$("$TOOL" "$GOLDEN_BARE" "$EMPTY_SEED" "${TEST_VAR}/empty-output.patch" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "Empty seed (no overlays) exits 1"
else
    fail "Empty seed should exit 1, got $RC"
fi

if echo "$OUT" | grep -qi "no overlay"; then
    pass "Empty seed produces 'no overlay files' error"
else
    fail "Empty seed missing appropriate error message"
fi

# ── Test 8: Monorepo --cwd generation ───────────────────────────────

echo ""
echo "--- Test: monorepo --cwd generation ---"

setup_monorepo_golden

POLY_BARE="${TEST_VAR}/poly-fixture.git"
POLY_SEED="${TEST_VAR}/python-seeds/POLY-BUG-1"
POLY_OUTPUT="${TEST_VAR}/poly-fix.patch"

"$TOOL" "$POLY_BARE" "$POLY_SEED" "$POLY_OUTPUT" --cwd python/

if [ -f "$POLY_OUTPUT" ] && [ -s "$POLY_OUTPUT" ]; then
    pass "Monorepo fix patch generated (--cwd python/)"
else
    fail "Monorepo fix patch missing or empty"
fi

# Verify paths: should use repo-root-relative paths like python/src/lib/math.py
if grep -q 'python/src/lib/math.py' "$POLY_OUTPUT"; then
    pass "Monorepo patch uses repo-root-relative paths (python/src/lib/math.py)"
else
    fail "Monorepo patch missing repo-root-relative paths"
    echo "    Patch content preview:" >&2
    head -10 "$POLY_OUTPUT" >&2
fi

# Verify patch applies cleanly (on seeded clone)
CLONE_DIR="$(mktemp -d "${TMPDIR}/regenerate-mono-apply-XXXXXX")"
git clone -q "$POLY_BARE" "$CLONE_DIR" 2>/dev/null

# Apply same seed overlay to introduce the bug
for f in "$POLY_SEED"/*; do
    [ -f "$f" ] || continue
    bn="$(basename "$f")"
    case "$bn" in fix.patch|SEEDS.md|.gitkeep) continue ;; esac
    dest=$(find "$CLONE_DIR/python" -type f -name "$bn" -not -path '*/.git/*' 2>/dev/null | head -1)
    [ -n "$dest" ] && cp "$f" "$dest"
done

if (cd "$CLONE_DIR" && git apply --check "$POLY_OUTPUT" 2>&1); then
    pass "Monorepo patch passes git apply --check on seeded clone"
else
    fail "Monorepo patch FAILS git apply --check on seeded clone"
fi

rm -rf "$CLONE_DIR"

# ── Test 9: Monorepo --cwd with non-existent subdir ────────────────

echo ""
echo "--- Test: --cwd with non-existent subdirectory ---"

set +e
OUT=$("$TOOL" "$POLY_BARE" "$POLY_SEED" "${TEST_VAR}/bad-out.patch" --cwd "nonexistent/" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "--cwd nonexistent/ exits 1"
else
    fail "--cwd nonexistent/ should exit 1, got $RC"
fi

if echo "$OUT" | grep -qi "not found"; then
    pass "--cwd nonexistent/ produces clear error"
else
    fail "--cwd nonexistent/ missing clear error message"
fi

# ── Test 10: --cwd argument without value ───────────────────────────

echo ""
echo "--- Test: --cwd without value ---"

set +e
OUT=$("$TOOL" "$POLY_BARE" "$POLY_SEED" "${TEST_VAR}/bad-out.patch" --cwd 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "--cwd without value exits 2"
else
    fail "--cwd without value should exit 2, got $RC"
fi

# ── Test 11: Unknown option ─────────────────────────────────────────

echo ""
echo "--- Test: unknown option ---"

set +e
OUT=$("$TOOL" "$POLY_BARE" "$POLY_SEED" "${TEST_VAR}/bad-out.patch" --bad-flag 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "Unknown option exits 2"
else
    fail "Unknown option should exit 2, got $RC"
fi

if echo "$OUT" | grep -qi "unknown"; then
    pass "Unknown option produces clear error message"
else
    fail "Unknown option missing error message"
fi

# ── Test 12: Script is executable ───────────────────────────────────

echo ""
echo "--- Test: script is executable ---"

if [ -x "$TOOL" ]; then
    pass "Script is executable"
else
    fail "Script is not executable"
fi

# ── Test 13: --map with path mapping ──────────────────────────────

echo ""
echo "--- Test: --map with path mapping ---"

# Create golden bare with file in a subdirectory
MAP_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-map-test-XXXXXX")
MAP_WORK=$(mktemp -d "${TMPDIR}/regenerate-map-work-XXXXXX")
(
    cd "$MAP_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    mkdir -p util
    echo 'package util

func DoThing() string {
    return "hello"
}' > util/command.go
    echo 'package main' > main.go
    git add -A
    git commit -q -m "Initial baseline"
)
MAP_BARE="${MAP_TEST_VAR}/map-fixture.git"
git init --bare "$MAP_BARE" > /dev/null 2>&1
(
    cd "$MAP_WORK"
    git push "$MAP_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$MAP_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$MAP_WORK"

# Create seed with a differently-named file
MAP_SEED="${MAP_TEST_VAR}/seeds/MAP-TEST"
mkdir -p "$MAP_SEED"
echo 'package util

func DoThing() string {
    return "buggy"
}' > "$MAP_SEED/util_command.go"
touch "$MAP_SEED/fix.patch"

MAP_OUTPUT="${MAP_TEST_VAR}/map-output.patch"
"$TOOL" "$MAP_BARE" "$MAP_SEED" "$MAP_OUTPUT" --map util_command.go=util/command.go

if [ -s "$MAP_OUTPUT" ]; then
    pass "--map generates non-empty patch with path mapping"
else
    fail "--map generated empty patch"
fi

# Verify patch references util/command.go (the mapped path)
if grep -q 'util/command.go' "$MAP_OUTPUT"; then
    pass "--map patch uses mapped path (util/command.go)"
else
    fail "--map patch missing mapped path"
fi

rm -rf "$MAP_TEST_VAR"

# ── Test 14: --map without = separator ────────────────────────────

echo ""
echo "--- Test: --map without = separator ---"

BAD_MAP_TEST=$(mktemp -d "${TMPDIR}/regenerate-badmap-XXXXXX")
mkdir -p "$BAD_MAP_TEST/dummy" >> /dev/null

set +e
OUT=$("$TOOL" "/nonexistent" "/nonexistent" "/tmp/out" --map "bad_value" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "--map without = exits 2"
else
    fail "--map without = should exit 2, got $RC"
fi

if echo "$OUT" | grep -qi "name=path"; then
    pass "--map without = produces name=path format hint"
else
    fail "--map without = missing format hint"
fi

rm -rf "$BAD_MAP_TEST"

# ── Test 15: --map without value ──────────────────────────────────

echo ""
echo "--- Test: --map without value ---"

set +e
OUT=$("$TOOL" "/nonexistent" "/nonexistent" "/tmp/out" --map 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "--map without value exits 2"
else
    fail "--map without value should exit 2, got $RC"
fi

# ── Test 16: New file handling (seed adds file not in baseline) ───

echo ""
echo "--- Test: new file handling ---"

NEW_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-newfile-XXXXXX")
NEW_WORK=$(mktemp -d "${TMPDIR}/regenerate-newfile-work-XXXXXX")
(
    cd "$NEW_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    echo 'package main

func main() {}' > main.go
    git add -A
    git commit -q -m "Initial baseline"
)
NEW_BARE="${NEW_TEST_VAR}/newfile-fixture.git"
git init --bare "$NEW_BARE" > /dev/null 2>&1
(
    cd "$NEW_WORK"
    git push "$NEW_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$NEW_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$NEW_WORK"

NEW_SEED="${NEW_TEST_VAR}/seeds/NEW-FILE"
mkdir -p "$NEW_SEED"
echo 'package main

func worker() {
    // new file with bug
    return
}' > "$NEW_SEED/worker.go"
touch "$NEW_SEED/fix.patch"

NEW_OUTPUT="${NEW_TEST_VAR}/newfile-output.patch"
"$TOOL" "$NEW_BARE" "$NEW_SEED" "$NEW_OUTPUT"

if [ -s "$NEW_OUTPUT" ]; then
    pass "New file seed generates non-empty patch"
else
    fail "New file seed generated empty patch"
fi

# Verify patch contains the new file content (as removal in -R diff)
if grep -q 'worker.go' "$NEW_OUTPUT"; then
    pass "New file patch references the new file"
else
    fail "New file patch missing file reference"
fi

rm -rf "$NEW_TEST_VAR"

# ── Test 17: go.mod is skipped in seed overlays ───────────────────

echo ""
echo "--- Test: go.mod skipped in seed overlays ---"

GOMOD_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-gomod-XXXXXX")
GOMOD_WORK=$(mktemp -d "${TMPDIR}/regenerate-gomod-work-XXXXXX")
(
    cd "$GOMOD_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    echo 'module test' > go.mod
    echo 'package main' > main.go
    git add -A
    git commit -q -m "Initial baseline"
)
GOMOD_BARE="${GOMOD_TEST_VAR}/gomod-fixture.git"
git init --bare "$GOMOD_BARE" > /dev/null 2>&1
(
    cd "$GOMOD_WORK"
    git push "$GOMOD_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$GOMOD_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$GOMOD_WORK"

GOMOD_SEED="${GOMOD_TEST_VAR}/seeds/GOMOD-TEST"
mkdir -p "$GOMOD_SEED"
echo 'module example.com/test' > "$GOMOD_SEED/go.mod"
echo 'package main

func broken() {}' > "$GOMOD_SEED/main.go"
touch "$GOMOD_SEED/fix.patch"

GOMOD_OUTPUT="${GOMOD_TEST_VAR}/gomod-output.patch"
"$TOOL" "$GOMOD_BARE" "$GOMOD_SEED" "$GOMOD_OUTPUT"

# go.mod should NOT appear in the patch since it was skipped
if grep -q 'go.mod' "$GOMOD_OUTPUT"; then
    fail "go.mod appears in patch — should have been skipped"
else
    pass "go.mod correctly skipped — not in generated patch"
fi

rm -rf "$GOMOD_TEST_VAR"

# ── Test 18: --help documents --map option ────────────────────────

echo ""
echo "--- Test: --help documents --map ---"

help_out=$("$TOOL" --help 2>&1)
if echo "$help_out" | grep -q "\-\-map"; then
    pass "--help documents --map option"
else
    fail "--help missing --map documentation"
fi

# ── Test 19: seeds/ directory exclusion in find ───────────────────

echo ""
echo "--- Test: seeds/ directory exclusion ---"

SEEDEXCL_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-seedexcl-XXXXXX")
SEEDEXCL_WORK=$(mktemp -d "${TMPDIR}/regenerate-seedexcl-work-XXXXXX")
(
    cd "$SEEDEXCL_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    mkdir -p seeds/BUG-1
    echo 'green version' > seeds/BUG-1/overlay.txt
    echo 'green version' > overlay.txt
    git add -A
    git commit -q -m "Baseline with seeds/ dir"
)
SEEDEXCL_BARE="${SEEDEXCL_TEST_VAR}/seedexcl-fixture.git"
git init --bare "$SEEDEXCL_BARE" > /dev/null 2>&1
(
    cd "$SEEDEXCL_WORK"
    git push "$SEEDEXCL_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$SEEDEXCL_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$SEEDEXCL_WORK"

# Seed with different content
SEEDEXCL_SEED="${SEEDEXCL_TEST_VAR}/seeds/TEST"
mkdir -p "$SEEDEXCL_SEED"
echo 'buggy version' > "$SEEDEXCL_SEED/overlay.txt"
touch "$SEEDEXCL_SEED/fix.patch"

SEEDEXCL_OUTPUT="${SEEDEXCL_TEST_VAR}/seedexcl-output.patch"
"$TOOL" "$SEEDEXCL_BARE" "$SEEDEXCL_SEED" "$SEEDEXCL_OUTPUT"

# Should produce non-empty patch (overlay differs from green)
if [ -s "$SEEDEXCL_OUTPUT" ]; then
    pass "seeds/ exclusion: patch generated from root file (not seeds/ shadow)"
else
    fail "seeds/ exclusion: generated empty patch"
fi

rm -rf "$SEEDEXCL_TEST_VAR"

# ── Test 20: Multiple --map options ────────────────────────────────

echo ""
echo "--- Test: multiple --map options ---"

MULTI_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-multimap-XXXXXX")
MULTI_WORK=$(mktemp -d "${TMPDIR}/regenerate-multimap-work-XXXXXX")
(
    cd "$MULTI_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    mkdir -p src/util
    echo 'pub fn a() {}' > src/bucket.rs
    echo 'pub fn b() {}' > src/config.rs
    git add -A
    git commit -q -m "Baseline"
)
MULTI_BARE="${MULTI_TEST_VAR}/multi-fixture.git"
git init --bare "$MULTI_BARE" > /dev/null 2>&1
(
    cd "$MULTI_WORK"
    git push "$MULTI_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$MULTI_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$MULTI_WORK"

MULTI_SEED="${MULTI_TEST_VAR}/seeds/MULTI"
mkdir -p "$MULTI_SEED"
echo 'pub fn a() { // buggy }' > "$MULTI_SEED/bucket.rs"
echo 'pub fn b() { // buggy }' > "$MULTI_SEED/config.rs"
touch "$MULTI_SEED/fix.patch"

MULTI_OUTPUT="${MULTI_TEST_VAR}/multi-output.patch"
"$TOOL" "$MULTI_BARE" "$MULTI_SEED" "$MULTI_OUTPUT" \
    --map bucket.rs=src/bucket.rs \
    --map config.rs=src/config.rs

if [ -s "$MULTI_OUTPUT" ]; then
    pass "Multiple --map generates non-empty patch"
    if grep -q 'src/bucket.rs' "$MULTI_OUTPUT" && grep -q 'src/config.rs' "$MULTI_OUTPUT"; then
        pass "Multiple --map both targets appear in patch"
    else
        fail "Multiple --map missing expected paths"
    fi
else
    fail "Multiple --map generated empty patch"
fi

rm -rf "$MULTI_TEST_VAR"

# ── Test 21: Dormant seed produces clear error ────────────────────

echo ""
echo "--- Test: dormant seed error message ---"

DORM_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-dormant-XXXXXX")
DORM_WORK=$(mktemp -d "${TMPDIR}/regenerate-dormant-work-XXXXXX")
(
    cd "$DORM_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    echo 'unchanged content' > file.txt
    git add -A
    git commit -q -m "Baseline"
)
DORM_BARE="${DORM_TEST_VAR}/dormant-fixture.git"
git init --bare "$DORM_BARE" > /dev/null 2>&1
(
    cd "$DORM_WORK"
    git push "$DORM_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$DORM_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$DORM_WORK"

DORM_SEED="${DORM_TEST_VAR}/seeds/DORMANT"
mkdir -p "$DORM_SEED"
echo 'unchanged content' > "$DORM_SEED/file.txt"
touch "$DORM_SEED/fix.patch"

DORM_OUTPUT="${DORM_TEST_VAR}/dormant-output.patch"
set +e
OUT=$("$TOOL" "$DORM_BARE" "$DORM_SEED" "$DORM_OUTPUT" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "Dormant seed exits 1"
else
    fail "Dormant seed should exit 1, got $RC"
fi

if echo "$OUT" | grep -qi "dormant\|empty"; then
    pass "Dormant seed error mentions dormant/empty"
else
    fail "Dormant seed error missing dormant/empty hint"
fi

rm -rf "$DORM_TEST_VAR"

# ── Test 22: --branch option generates patch on named branch ────

echo ""
echo "--- Test: --branch option generates patch on named branch ---"

BRANCH_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-branch-XXXXXX")
BRANCH_WORK=$(mktemp -d "${TMPDIR}/regenerate-branch-work-XXXXXX")
(
    cd "$BRANCH_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    echo 'green content' > shared.go
    git add -A
    git commit -q -m "Initial baseline"
    git checkout -qb feature
    echo 'buggy content on feature branch' > shared.go
    git add -A
    git commit -q -m "Feature with bug"
    git checkout -q main
)
BRANCH_BARE="${BRANCH_TEST_VAR}/branch-fixture.git"
git init --bare "$BRANCH_BARE" > /dev/null 2>&1
(
    cd "$BRANCH_WORK"
    git push "$BRANCH_BARE" HEAD:refs/heads/main > /dev/null 2>&1
    git push "$BRANCH_BARE" refs/heads/feature:refs/heads/feature > /dev/null 2>&1
)
git --git-dir="$BRANCH_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$BRANCH_WORK"

# Create seed with buggy content matching the feature branch
BRANCH_SEED="${BRANCH_TEST_VAR}/seeds/BUG-X"
mkdir -p "$BRANCH_SEED"
echo 'buggy content on feature branch' > "$BRANCH_SEED/shared.go"
touch "$BRANCH_SEED/fix.patch"

BRANCH_OUTPUT="${BRANCH_TEST_VAR}/branch-output.patch"

# Without --branch, the buggy seed should differ from main → produces fix patch
# With --branch feature, the buggy seed matches → dormant (would exit 1)
# Test: seed that differs from feature branch but matches main

# Actually test: a seed that introduces a bug on feature branch
# where the file exists on feature but not on main

# Simpler test: --branch with a branch that has different green baseline
# Create a fixture where main has "green" and feature has "buggy"
# The seed overlay for feature contains "green" (fix direction)
# But that's inverted...

# Let's test that --branch works for checking out a named branch
# and generating a patch from the seed overlay applied there.

# Setup: feature branch has file at path src/file.go
BRANCH2_WORK=$(mktemp -d "${TMPDIR}/regenerate-branch2-work-XXXXXX")
(
    cd "$BRANCH2_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    mkdir -p src
    echo 'green' > src/file.go
    git add -A
    git commit -q -m "Baseline"
)
BRANCH2_BARE="${BRANCH_TEST_VAR}/branch2-fixture.git"
git init --bare "$BRANCH2_BARE" > /dev/null 2>&1
(
    cd "$BRANCH2_WORK"
    git push "$BRANCH2_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$BRANCH2_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$BRANCH2_WORK"

BRANCH2_SEED="${BRANCH_TEST_VAR}/seeds/BUG-Y"
mkdir -p "$BRANCH2_SEED"
echo 'buggy' > "$BRANCH2_SEED/file.go"
touch "$BRANCH2_SEED/fix.patch"

BRANCH2_OUTPUT="${BRANCH_TEST_VAR}/branch2-output.patch"
"$TOOL" "$BRANCH2_BARE" "$BRANCH2_SEED" "$BRANCH2_OUTPUT" --branch main

if [ -s "$BRANCH2_OUTPUT" ]; then
    pass "--branch main generates non-empty patch"
    if grep -q 'src/file.go' "$BRANCH2_OUTPUT"; then
        pass "--branch main patch uses correct paths"
    else
        fail "--branch main patch missing expected paths"
    fi
else
    fail "--branch main generated empty patch"
fi

rm -rf "$BRANCH_TEST_VAR"

# ── Test 23: --branch with non-existent branch name ────────────────

echo ""
echo "--- Test: --branch with non-existent branch ---"

BRANCH3_TEST_VAR=$(mktemp -d "${TMPDIR}/regenerate-branch3-XXXXXX")
BRANCH3_WORK=$(mktemp -d "${TMPDIR}/regenerate-branch3-work-XXXXXX")
(
    cd "$BRANCH3_WORK"
    git init --initial-branch=main > /dev/null 2>&1
    git config user.email "test@fixtures.invalid"
    git config user.name "Test Fixture"
    echo 'content' > file.txt
    git add -A
    git commit -q -m "Baseline"
)
BRANCH3_BARE="${BRANCH3_TEST_VAR}/branch3-fixture.git"
git init --bare "$BRANCH3_BARE" > /dev/null 2>&1
(
    cd "$BRANCH3_WORK"
    git push "$BRANCH3_BARE" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$BRANCH3_BARE" symbolic-ref HEAD refs/heads/main
rm -rf "$BRANCH3_WORK"

BRANCH3_SEED="${BRANCH3_TEST_VAR}/seeds/TEST"
mkdir -p "$BRANCH3_SEED"
echo 'buggy' > "$BRANCH3_SEED/file.txt"
touch "$BRANCH3_SEED/fix.patch"

set +e
OUT=$("$TOOL" "$BRANCH3_BARE" "$BRANCH3_SEED" "${BRANCH3_TEST_VAR}/out.patch" --branch "no-such-branch" 2>&1)
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
    pass "--branch with non-existent branch exits 1"
else
    fail "--branch with non-existent branch should exit 1, got $RC"
fi

if echo "$OUT" | grep -qi "branch not found"; then
    pass "--branch with non-existent produces 'branch not found' error"
else
    fail "--branch with non-existent missing clear error message"
fi

rm -rf "$BRANCH3_TEST_VAR"

# ── Test 24: --branch without value ─────────────────────────────

echo ""
echo "--- Test: --branch without value ---"

set +e
OUT=$("$TOOL" "/nonexistent" "/nonexistent" "/tmp/out" --branch 2>&1)
RC=$?
set -e

if [ "$RC" -eq 2 ]; then
    pass "--branch without value exits 2"
else
    fail "--branch without value should exit 2, got $RC"
fi

# ── Test 25: --help documents --branch option ──────────────────────

echo ""
echo "--- Test: --help documents --branch ---"

help_out=$("$TOOL" --help 2>&1)
if echo "$help_out" | grep -q "\-\-branch"; then
    pass "--help documents --branch option"
else
    fail "--help missing --branch documentation"
fi

# ── Tests for US-004: tt-poly-lite/python fix patch paths ──────────
# These tests verify the actual repo fix patches, not sandbox fixtures.
# Skip if golden bare doesn't exist (run build-golden.sh first).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_SRC="${REPO_ROOT}/torture-test/fixtures-src/tt-poly-lite"
GOLDEN_BARE="${REPO_ROOT}/torture-test/var/fixtures/golden/tt-poly-lite.git"

POLY_PYTHON_SEEDS=(POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4 POLY-VULN-P1 POLY-VULN-P2 POLY-BRK-P1 POLY-BRK-P2)

# Test: all 8 tt-poly-lite/python fix patches use python/ prefix
echo ""
echo "--- Test: tt-poly-lite/python fix patches use python/ prefix ---"
all_prefixed=true
for seed_id in "${POLY_PYTHON_SEEDS[@]}"; do
    fix_patch="$FIXTURE_SRC/python/seeds/$seed_id/fix.patch"
    first_path=$(grep -m1 '^--- ' "$fix_patch" 2>/dev/null | sed 's/^--- //' || true)
    if echo "$first_path" | grep -qE '(^|[ab]/)python/'; then
        :  # passes
    else
        fail "$seed_id fix.patch missing python/ prefix (got: $first_path)"
        all_prefixed=false
    fi
done
if $all_prefixed; then
    pass "all 8 tt-poly-lite/python fix patches use python/ prefix"
fi

# Test: all 8 tt-poly-lite/python fix patches apply cleanly
echo ""
echo "--- Test: tt-poly-lite/python fix patches apply cleanly ---"
if [ -d "$GOLDEN_BARE" ]; then
    all_apply=true
    for seed_id in "${POLY_PYTHON_SEEDS[@]}"; do
        fix_patch="$FIXTURE_SRC/python/seeds/$seed_id/fix.patch"
        test_work=$(mktemp -d "${TMPDIR}/rpf-test-poly-apply.XXXXXX")
        git clone -q "$GOLDEN_BARE" "$test_work" 2>/dev/null || {
            fail "$seed_id: failed to clone golden bare"
            all_apply=false
            rm -rf "$test_work"
            continue
        }
        case "$seed_id" in
            POLY-BRK-*)
                # BRK seeds: checkout broken-tests branch (has buggy code)
                (cd "$test_work" && git checkout -q broken-tests 2>/dev/null) || true
                ;;
            POLY-BUG-*)
                # BUG seeds: apply seed overlay first to introduce bugs
                seed_dir="$FIXTURE_SRC/python/seeds/$seed_id"
                for f in "$seed_dir"/*; do
                    bn="$(basename "$f")"
                    case "$bn" in fix.patch|SEEDS.md|.gitkeep) continue ;; esac
                    tgt=$(find "$test_work/python" -type f -name "$bn" \
                        -not -path '*/.git/*' -not -path '*/__pycache__/*' \
                        -not -path '*/.venv/*' 2>/dev/null | head -1)
                    if [ -n "$tgt" ]; then
                        cp "$f" "$tgt"
                    fi
                done
                ;;
            # VULN seeds: dormant — buggy code already in baseline, apply fix directly
        esac
        if (cd "$test_work" && git apply --check -p1 "$fix_patch" 2>&1); then
            :  # passes
        else
            fail "$seed_id fix.patch does not apply cleanly (p1)"
            all_apply=false
        fi
        rm -rf "$test_work"
    done
    if $all_apply; then
        pass "all 8 tt-poly-lite/python fix patches apply cleanly"
    fi
else
    pass "golden bare not built yet — skipping apply-cleanly test (8 patches)"
fi

# ── Results ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
printf "  Tests:  Passed: %d  Failed: %d\n" "$PASSES" "$FAILURES"
echo "══════════════════════════════════════════════════════════════════"

if [ "$FAILURES" -gt 0 ]; then
    exit 1
fi
exit 0
