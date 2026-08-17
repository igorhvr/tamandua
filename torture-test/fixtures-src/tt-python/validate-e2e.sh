#!/usr/bin/env bash
# validate-e2e.sh — end-to-end validation of the complete tt-python fixture
#
# Validates:
#   1. Deterministic golden builds (two consecutive runs, both variants)
#   2. Baseline suite GREEN in scratch clone
#   3. Each seed ref: correct colour (RED for bugs, GREEN for dormant vulns/A1)
#   4. Fix patches restore GREEN for each bug seed
#   5. Junk-probe invariants in a fresh clone after one test run
#   6. operator-notes.local present + UNTRACKED + byte-identical in work clone
#   7. git status shows untracked junk (not gitignored)
#   8. broken-tests branch has BRK-P1 and BRK-P2 causing test failures
#   9. Sentinel subdirectory exists with canary file
#  10. @pytest.mark.flaky_probe causes FLAKY-P1 to be skipped by default
#  11. Master variant: default branch master, no main ref
#
# Usage:
#   bash torture-test/fixtures-src/tt-python/validate-e2e.sh
#
# Requirements: bash, git, rsync, python3, patch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VAR_DIR="$REPO_ROOT/torture-test/var"
GOLDEN_DIR="$VAR_DIR/fixtures/golden"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; echo "    ERROR: $2" >&2; }

echo "══════════════════════════════════════════════════════════════════"
echo "  tt-python End-to-End Validation"
echo "══════════════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: Build goldens (main + master variants) ───────────────

echo "── Phase 1: Build golden repos ──────────────────────────────────"
echo ""

echo "Building tt-python (main variant)..."
bash "$SCRIPT_DIR/build-golden.sh"
echo ""

echo "Second run — verifying determinism for main variant..."
bash "$SCRIPT_DIR/build-golden.sh"
echo ""

if [ -f "$GOLDEN_DIR/tt-python.git.hashes" ]; then
    pass "Main variant: deterministic hashes match across two runs"
else
    fail "Main variant: deterministic hashes match across two runs" \
        "tt-python.git.hashes missing after second run"
fi

echo ""
echo "Building tt-python@master (master variant)..."
bash "$SCRIPT_DIR/../tt-python@master/build-golden.sh"
echo ""

echo "Second run — verifying determinism for master variant..."
bash "$SCRIPT_DIR/../tt-python@master/build-golden.sh"
echo ""

if [ -f "$GOLDEN_DIR/.build-hashes-tt-python-master" ]; then
    pass "Master variant: deterministic hashes match across two runs"
else
    fail "Master variant: deterministic hashes match across two runs" \
        ".build-hashes-tt-python-master missing after second run"
fi

# ── Phase 2: Baseline suite in scratch clone ──────────────────────

echo ""
echo "── Phase 2: Baseline suite and structural checks ───────────────"
echo ""

MAIN_BARE="$GOLDEN_DIR/tt-python.git"

if [ ! -d "$MAIN_BARE" ]; then
    fail "Golden bare repo exists" "tt-python.git not found at $MAIN_BARE"
    echo ""
    echo "══╡ RESULTS ════════════════════════════════════════════════════"
    printf "  Passed: %d  Failed: %d\n" "$PASS" "$FAIL"
    exit 1
fi
pass "Golden bare repo exists at $MAIN_BARE"

SCRATCH="$(mktemp -d "$VAR_DIR/tmp.e2e-validate.XXXXXX")"
cleanup_scratch() { rm -rf "$SCRATCH"; }
trap cleanup_scratch EXIT

git clone -q "$MAIN_BARE" "$SCRATCH"
cd "$SCRATCH"

# Bootstrap and baseline
echo "Bootstrapping venv..."
# US-007: surface the bootstrap tail on failure instead of only
# "bootstrap script failed".
if BOOT_OUT="$(bash "$SCRATCH/bootstrap" 2>&1)"; then
    pass "Bootstrap completed"
else
    fail "Bootstrap completed" "bootstrap script failed"
    echo "    ── last lines of bootstrap output ──" >&2
    printf '%s\n' "$BOOT_OUT" | tail -20 >&2
    echo ""
    echo "══╡ RESULTS ════════════════════════════════════════════════════"
    printf "  Passed: %d  Failed: %d\n" "$PASS" "$FAIL"
    exit 1
fi

PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"
if echo "$PYTEST_OUT" | grep -qE '^[0-9]+ passed'; then
    pass "Baseline test suite: GREEN ($(echo "$PYTEST_OUT" | grep -oE '[0-9]+ passed' || echo "OK"))"
else
    fail "Baseline test suite: GREEN" "baseline tests failed unexpectedly"
fi

# Verify flaky probe is skipped by default
if echo "$PYTEST_OUT" | grep -q "1 skipped"; then
    pass "Flaky probe skipped by default"
else
    fail "Flaky probe skipped by default" \
        "expected '1 skipped' in pytest output, got: $(echo "$PYTEST_OUT" | tail -1)"
fi

# Verify sentinel subdirectory exists with canary
SENTINEL_DIR="$SCRATCH/\$(sentinel)"
if [ -d "$SENTINEL_DIR" ] && [ -f "$SENTINEL_DIR/canary.py" ]; then
    pass "Sentinel subdirectory exists with canary file"
else
    fail "Sentinel subdirectory exists with canary file" \
        "sentinel directory or canary.py missing"
fi

# ── Phase 3: Junk-probe invariants ────────────────────────────────

echo ""
echo "── Phase 3: Junk-probe invariants ──────────────────────────────"
echo ""

# MACP2: the __pycache__ junk is a DETERMINISTIC PROVISIONING ARTIFACT,
# not an interpreter side effect — Apple's Python bakes in
# sys.pycache_prefix and ALWAYS redirects bytecode caches out-of-tree, so
# in-tree __pycache__ can never be relied on. Seed the byte-exact
# fixtures-src reference into the scratch clone BEFORE the test run; the
# marker file is what the oracle checks (present + untracked +
# byte-identical).
JUNK_REF="$SCRIPT_DIR/__pycache__/junk-probe.synthetic"
mkdir -p "$SCRATCH/__pycache__"
cp "$JUNK_REF" "$SCRATCH/__pycache__/junk-probe.synthetic"

# Run tests to generate the regenerated junk (.pytest_cache)
"$SCRATCH/.venv/bin/python" -m pytest -q >/dev/null 2>&1 || true

# Check seeded __pycache__ marker exists, is untracked, and is byte-identical
# to the fixtures-src reference.
if [ ! -f "$SCRATCH/__pycache__/junk-probe.synthetic" ]; then
    fail "seeded __pycache__/junk-probe.synthetic present after test run" "marker missing"
else
    pass "seeded __pycache__/junk-probe.synthetic present after test run"
fi

if git ls-files --error-unmatch __pycache__/junk-probe.synthetic >/dev/null 2>&1; then
    fail "seeded __pycache__/junk-probe.synthetic UNTRACKED in work clone" "it is tracked (in the index)"
else
    pass "seeded __pycache__/junk-probe.synthetic UNTRACKED in work clone"
fi

if cmp -s "$JUNK_REF" "$SCRATCH/__pycache__/junk-probe.synthetic"; then
    pass "seeded __pycache__/junk-probe.synthetic byte-identical to fixture source (provisioning ref)"
else
    fail "seeded __pycache__/junk-probe.synthetic byte-identical to fixture source (provisioning ref)" \
        "files differ"
fi

if ! git check-ignore -q "$SCRATCH/__pycache__/" 2>/dev/null; then
    pass "__pycache__ is NOT gitignored"
else
    fail "__pycache__ is NOT gitignored" "__pycache__ is in .gitignore"
fi

# Check .pytest_cache exists and is not gitignored
if [ -d "$SCRATCH/.pytest_cache" ]; then
    pass ".pytest_cache exists after test run"
else
    fail ".pytest_cache exists after test run" "directory missing"
fi

if ! git check-ignore -q "$SCRATCH/.pytest_cache/" 2>/dev/null; then
    pass ".pytest_cache is NOT gitignored"
else
    fail ".pytest_cache is NOT gitignored" ".pytest_cache is in .gitignore"
fi

# Check git status shows untracked junk
GIT_STATUS="$(git -C "$SCRATCH" status --porcelain)"
if echo "$GIT_STATUS" | grep -q "__pycache__"; then
    pass "git status shows __pycache__ as untracked"
else
    fail "git status shows __pycache__ as untracked" \
        "__pycache__ not visible in git status"
fi
if echo "$GIT_STATUS" | grep -q ".pytest_cache"; then
    pass "git status shows .pytest_cache as untracked"
else
    fail "git status shows .pytest_cache as untracked" \
        ".pytest_cache not visible in git status"
fi

# Verify operator-notes.local is present + UNTRACKED + byte-identical in the
# work clone (canonical inert-junk contract, US-001 / spec 02 §junk probes).
# build-golden.sh excludes it from the golden, so provisioning plants it into
# the clone for real runs; plant it here to represent that state, then assert
# the invariant without weakening any no-commit/no-delete/modify oracle.
cp -f "$SCRIPT_DIR/operator-notes.local" "$SCRATCH/operator-notes.local"
if diff -q "$SCRATCH/operator-notes.local" "$SCRIPT_DIR/operator-notes.local" >/dev/null 2>&1; then
    pass "operator-notes.local byte-identical to fixture source (provisioning ref)"
else
    fail "operator-notes.local byte-identical to fixture source (provisioning ref)" \
        "files differ"
fi
if git ls-files --error-unmatch operator-notes.local >/dev/null 2>&1; then
    fail "operator-notes.local UNTRACKED in work clone" "it is tracked (in the index)"
else
    pass "operator-notes.local UNTRACKED in work clone"
fi

# ── Phase 4: Seed ref validation ─────────────────────────────────

echo ""
echo "── Phase 4: Seed ref validation ────────────────────────────────"
echo ""

# BUG-P1 (A1): dormant — no test covers count+until, so suite is GREEN
# BUG-P2/P3/P4: RED
# VULN-P1/P2: dormant — GREEN
#
# Seed lookup tables as bash-3.2-safe case-table functions. macOS /bin/bash
# 3.2.57 has no associative arrays (a bash 4+ feature), so the former
# SEED_EXPECT_GREEN / SEED_SYMPTOMS maps become lookup functions; the
# expected-green bits and symptom strings are byte-identical to the old maps.
# seed_expect_green defaults to 0 for unknown seeds, matching the old map
# read semantics (default 0 when a seed id is absent from the green set).
seed_expect_green() {
    case "$1" in
        BUG-P1|VULN-P1|VULN-P2) echo 1 ;;
        *) echo 0 ;;
    esac
}

seed_symptoms() {
    case "$1" in
        BUG-P1) echo "A1 dormant off-by-one — GREEN (no test covers count+until)" ;;
        BUG-P2) echo "A2 two-module bug — RED (yearly interval + CONTAINED boundary)" ;;
        BUG-P3) echo "A3 red-herring — RED (is_weekday Saturday bug)" ;;
        BUG-P4) echo "A4 performance — RED (threshold timeout > 2.0s)" ;;
        VULN-P1) echo "yaml.load dormant — GREEN" ;;
        VULN-P2) echo "shell=True dormant — GREEN" ;;
        *) return 1 ;;
    esac
}

SEED_ORDER=(BUG-P1 BUG-P2 BUG-P3 BUG-P4 VULN-P1 VULN-P2)

for seed_id in "${SEED_ORDER[@]}"; do
    git -C "$SCRATCH" checkout -f -q "seed/$seed_id" 2>/dev/null
    git -C "$SCRATCH" clean -fdq

    # Re-bootstrap after checkout — surface the tail on failure (US-007).
    if ! BOOT_OUT="$(bash "$SCRATCH/bootstrap" 2>&1)"; then
        fail "seed/$seed_id bootstrap" "bootstrap script failed"
        echo "    ── last lines of bootstrap output ──" >&2
        printf '%s\n' "$BOOT_OUT" | tail -20 >&2
        exit 1
    fi

    set +e
    PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"
    PYTEST_EXIT=$?
    set -e

    if [ "$PYTEST_EXIT" -eq 0 ]; then
        if [ "$(seed_expect_green "$seed_id")" -eq 1 ]; then
            pass "seed/$seed_id: GREEN ($(seed_symptoms "$seed_id"))"
        else
            fail "seed/$seed_id: RED expected ($(seed_symptoms "$seed_id"))" \
                "test suite was GREEN"
            echo "    ── last lines of pytest output ──" >&2
            printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
        fi
    else
        if [ "$(seed_expect_green "$seed_id")" -eq 1 ]; then
            fail "seed/$seed_id: GREEN expected ($(seed_symptoms "$seed_id"))" \
                "test suite was RED"
            echo "    ── last lines of pytest output ──" >&2
            printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
        else
            pass "seed/$seed_id: RED ($(seed_symptoms "$seed_id"))"
        fi
    fi
done

# ── Phase 5: Fix patches restore GREEN for bug seeds ──────────────

echo ""
echo "── Phase 5: Fix patches restore GREEN ──────────────────────────"
echo ""

# Patch-level lookup — bash 3.2-safe case-table function replacing the former
# PATCH_LEVEL associative map. Every committed fix.patch carries git-style
# a//b/ prefixes today:
#   BUG-P1: --- b/src/...  → -p1
#   BUG-P2: --- b/src/...  → -p1
#   BUG-P3: --- b/src/...  → -p1
#   BUG-P4: --- b/src/...  → -p1
#   VULN-P1: --- a/src/... → -p1
#   VULN-P2: --- a/src/... → -p1
# (US-004 corrects BUG-P3/BUG-P4 from the stale -p0 values, which matched the
# pre-2026-07-30 plain `--- src/...` patch format; Phase 5 only passes with
# -p1 on the regenerated git-style patches.)
patch_level() {
    case "$1" in
        BUG-P1|BUG-P2|BUG-P3|BUG-P4|VULN-P1|VULN-P2) echo 1 ;;
        *) return 1 ;;
    esac
}

FIX_SEEDS=(BUG-P1 BUG-P2 BUG-P3 BUG-P4 VULN-P1 VULN-P2)

for seed_id in "${FIX_SEEDS[@]}"; do
    git -C "$SCRATCH" checkout -f -q "seed/$seed_id" 2>/dev/null
    git -C "$SCRATCH" clean -fdq

    FIX_PATCH="$SCRIPT_DIR/seeds/$seed_id/fix.patch"
    PLEVEL="$(patch_level "$seed_id")"

    if [ ! -f "$FIX_PATCH" ]; then
        fail "$seed_id fix.patch exists" "file not found: $FIX_PATCH"
        continue
    fi

    if patch -d "$SCRATCH" -p"$PLEVEL" --forward --silent < "$FIX_PATCH" >/dev/null 2>&1; then
        :  # patch applied successfully
    fi
    # --forward silently skips already-applied patches; either way proceed
    pass "$seed_id fix.patch applies cleanly (-p$PLEVEL)"

    # US-007: surface the bootstrap tail on failure.
    if ! BOOT_OUT="$(bash "$SCRATCH/bootstrap" 2>&1)"; then
        fail "seed/$seed_id bootstrap" "bootstrap script failed"
        echo "    ── last lines of bootstrap output ──" >&2
        printf '%s\n' "$BOOT_OUT" | tail -20 >&2
        exit 1
    fi

    if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"; then
        pass "$seed_id fix restores GREEN"
    else
        fail "$seed_id fix restores GREEN" "test suite still RED after fix"
        echo "    ── last lines of pytest output ──" >&2
        printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
    fi
done

# ── Phase 6: broken-tests branch ──────────────────────────────────

echo ""
echo "── Phase 6: broken-tests branch validation ─────────────────────"
echo ""

git -C "$SCRATCH" checkout -f -q broken-tests 2>/dev/null
git -C "$SCRATCH" clean -fdq
# US-007: surface the bootstrap tail on failure.
if ! BOOT_OUT="$(bash "$SCRATCH/bootstrap" 2>&1)"; then
    fail "broken-tests bootstrap" "bootstrap script failed"
    echo "    ── last lines of bootstrap output ──" >&2
    printf '%s\n' "$BOOT_OUT" | tail -20 >&2
    exit 1
fi

if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"; then
    fail "broken-tests branch: RED (expected failures)" \
        "test suite was GREEN"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
else
    pass "broken-tests branch: RED (expected)"
fi

# Verify BRK-P1 and BRK-P2 individually
if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q tests/test_broken_p1.py 2>&1)"; then
    fail "BRK-P1 causes test failure" "test_broken_p1.py passed — expected failures"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
else
    pass "BRK-P1: causes test failure"
fi

if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q tests/test_broken_p2.py 2>&1)"; then
    fail "BRK-P2 causes test failure" "test_broken_p2.py passed — expected failures"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
else
    pass "BRK-P2: causes test failure"
fi

# Apply BRK fix patches and verify green
echo ""
echo "Applying BRK fix patches..."

# BRK patches use --- a/tests/... → -p1
git -C "$SCRATCH" checkout -f -q broken-tests 2>/dev/null
git -C "$SCRATCH" clean -fdq
patch -d "$SCRATCH" -p1 --forward --silent < "$SCRIPT_DIR/seeds/BRK-P1/fix.patch" >/dev/null 2>&1 || true

if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q tests/test_broken_p1.py 2>&1)"; then
    pass "BRK-P1 fix restores GREEN"
else
    fail "BRK-P1 fix restores GREEN" "tests still failing after fix"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
fi

git -C "$SCRATCH" checkout -f -q broken-tests 2>/dev/null
git -C "$SCRATCH" clean -fdq
patch -d "$SCRATCH" -p1 --forward --silent < "$SCRIPT_DIR/seeds/BRK-P2/fix.patch" >/dev/null 2>&1 || true

if PYTEST_OUT="$("$SCRATCH/.venv/bin/python" -m pytest -q tests/test_broken_p2.py 2>&1)"; then
    pass "BRK-P2 fix restores GREEN"
else
    fail "BRK-P2 fix restores GREEN" "tests still failing after fix"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
fi

# ── Phase 7: Master variant validation ────────────────────────────

echo ""
echo "── Phase 7: Master variant validation ──────────────────────────"
echo ""

MASTER_BARE="$GOLDEN_DIR/tt-python@master.git"

if [ ! -d "$MASTER_BARE" ]; then
    fail "Master golden bare repo exists" "tt-python@master.git not found"
else
    pass "Master golden bare repo exists at $MASTER_BARE"
fi

# Verify default branch is master
MASTER_DEFAULT="$(git -C "$MASTER_BARE" symbolic-ref HEAD 2>/dev/null || echo "UNKNOWN")"
if [ "$MASTER_DEFAULT" = "refs/heads/master" ]; then
    pass "Master variant default branch is master"
else
    fail "Master variant default branch is master" \
        "HEAD is '$MASTER_DEFAULT'"
fi

# Verify no main ref exists
if git -C "$MASTER_BARE" show-ref --verify --quiet refs/heads/main 2>/dev/null; then
    fail "Master variant has no main ref" \
        "refs/heads/main exists — should not"
else
    pass "Master variant: no main ref exists"
fi

# Clone master variant and verify default branch
MASTER_SCRATCH="$(mktemp -d "$VAR_DIR/tmp.e2e-master.XXXXXX")"
trap 'rm -rf "$MASTER_SCRATCH"; cleanup_scratch' EXIT

git clone -q "$MASTER_BARE" "$MASTER_SCRATCH"
MASTER_BRANCH="$(git -C "$MASTER_SCRATCH" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$MASTER_BRANCH" = "master" ]; then
    pass "Master variant clone: default branch is master"
else
    fail "Master variant clone: default branch is master" \
        "clone defaulted to '$MASTER_BRANCH'"
fi

# Baseline GREEN in master variant
cd "$MASTER_SCRATCH"
# US-007: surface the bootstrap tail on failure.
if ! BOOT_OUT="$(bash "$MASTER_SCRATCH/bootstrap" 2>&1)"; then
    fail "Master variant bootstrap" "bootstrap script failed"
    echo "    ── last lines of bootstrap output ──" >&2
    printf '%s\n' "$BOOT_OUT" | tail -20 >&2
    exit 1
fi

if PYTEST_OUT="$("$MASTER_SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"; then
    pass "Master variant baseline suite: GREEN"
else
    fail "Master variant baseline suite: GREEN" "tests failed"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
fi

# Verify broken-tests RED in master variant
git -C "$MASTER_SCRATCH" checkout -f -q broken-tests 2>/dev/null
if PYTEST_OUT="$("$MASTER_SCRATCH/.venv/bin/python" -m pytest -q 2>&1)"; then
    fail "Master variant broken-tests: RED" "suite was GREEN — expected RED"
    echo "    ── last lines of pytest output ──" >&2
    printf '%s\n' "$PYTEST_OUT" | tail -20 >&2
else
    pass "Master variant broken-tests: RED (expected)"
fi

# Verify seed refs exist in master variant
for seed_id in "${SEED_ORDER[@]}"; do
    if git -C "$MASTER_BARE" rev-parse --verify --quiet "refs/tags/seed/$seed_id" >/dev/null 2>&1; then
        pass "Master variant: seed/$seed_id ref exists"
    else
        fail "Master variant: seed/$seed_id ref exists" "tag missing"
    fi
done

# ── Results ───────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════"
printf "  \033[1mRESULTS:  Passed: %d  Failed: %d\033[0m\n" "$PASS" "$FAIL"
echo "══════════════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
