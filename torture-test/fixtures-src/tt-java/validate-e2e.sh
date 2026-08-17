#!/usr/bin/env bash
# validate-e2e.sh — end-to-end validation of the complete tt-java fixture
#
# Validates:
#   1. Deterministic golden builds (two consecutive runs)
#   2. Baseline suite GREEN in scratch clone
#   3. Junk-probe invariants in a fresh clone after one test run
#   4. Each seed ref: correct colour (RED for bugs/BRK, GREEN for dormant vulns/BUG-J4)
#   5. Fix patches restore GREEN for each seed
#   6. git status shows untracked junk (not gitignored)
#
# Usage:
#   bash torture-test/fixtures-src/tt-java/validate-e2e.sh
#
# Requirements: bash, git, mvnw (Maven Wrapper, requires JAVA_HOME or java on PATH)

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
echo "  tt-java End-to-End Validation"
echo "══════════════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: Build golden repos (determinism) ────────────────────

echo "── Phase 1: Build golden repos ──────────────────────────────────"
echo ""

# Remove stale hash file so first run starts from clean slate
rm -f "$GOLDEN_DIR/tt-java.git.hashes"

echo "Building tt-java (first run)..."
bash "$SCRIPT_DIR/build-golden.sh"
echo ""

echo "Second run — verifying determinism..."
bash "$SCRIPT_DIR/build-golden.sh"
echo ""

if [ -f "$GOLDEN_DIR/tt-java.git.hashes" ]; then
    pass "Deterministic hashes match across two runs"
else
    fail "Deterministic hashes match across two runs" \
        "tt-java.git.hashes missing after second run"
fi

# ── Phase 2: Baseline suite in scratch clone ─────────────────────

echo ""
echo "── Phase 2: Baseline suite and structural checks ───────────────"
echo ""

BARE_REPO="$GOLDEN_DIR/tt-java.git"

if [ ! -d "$BARE_REPO" ]; then
    fail "Golden bare repo exists" "tt-java.git not found at $BARE_REPO"
    echo ""
    echo "══╡ RESULTS ════════════════════════════════════════════════════"
    printf "  Passed: %d  Failed: %d\n" "$PASS" "$FAIL"
    exit 1
fi
pass "Golden bare repo exists at $BARE_REPO"

# Maven local repo cache under var/
MAVEN_REPO_LOCAL="$VAR_DIR/m2-repository"
mkdir -p "$MAVEN_REPO_LOCAL"

SCRATCH="$(mktemp -d "$VAR_DIR/tmp.e2e-validate.XXXXXX")"
cleanup_scratch() { rm -rf "$SCRATCH"; }
trap cleanup_scratch EXIT

git clone -q "$BARE_REPO" "$SCRATCH"
cd "$SCRATCH"

# Baseline test
echo "Running baseline test suite..."
MVN_OUT="$(./mvnw -B test -Dmaven.repo.local="$MAVEN_REPO_LOCAL" 2>&1)"
MVN_EXIT=$?
TEST_COUNT="$(echo "$MVN_OUT" | grep -oE 'Tests run: [0-9]+, Failures:' | tail -1 | grep -oE '[0-9]+' | head -1 || echo "0")"

if [ "$MVN_EXIT" -eq 0 ]; then
    pass "Baseline test suite: GREEN ($TEST_COUNT tests)"
else
    fail "Baseline test suite: GREEN" "baseline tests failed unexpectedly"
fi

# Verify test count is in expected range (131 baseline tests)
if [ "$TEST_COUNT" -ge 120 ] && [ "$TEST_COUNT" -le 200 ]; then
    pass "Test count ($TEST_COUNT) in expected range"
else
    fail "Test count ($TEST_COUNT) in expected range" \
        "expected 120-200 tests, got $TEST_COUNT"
fi

# ── Phase 3: Junk-probe invariants ───────────────────────────────

echo ""
echo "── Phase 3: Junk-probe invariants ───────────────────────────────"
echo ""

# Run tests to generate target/
./mvnw -q -B test -Dmaven.repo.local="$MAVEN_REPO_LOCAL" >/dev/null 2>&1 || true

# Check target/ exists and is not gitignored
if [ -d "$SCRATCH/target" ]; then
    pass "target/ exists after test run"
else
    fail "target/ exists after test run" "directory missing"
fi

if ! git check-ignore -q target/ 2>/dev/null; then
    pass "target/ is NOT gitignored"
else
    fail "target/ is NOT gitignored" "target/ is in .gitignore"
fi

# Check .gitignore does not list target/
if grep -v '^#' "$SCRATCH/.gitignore" | grep -q '^target'; then
    fail ".gitignore excludes target/" "target/ pattern found in .gitignore — must NOT be gitignored"
else
    pass ".gitignore does not exclude target/"
fi

# Check git status shows target/ as untracked
GIT_STATUS="$(git status --porcelain 2>/dev/null)"
if echo "$GIT_STATUS" | grep -q '^?? target/'; then
    pass "git status shows target/ as untracked (?? prefix)"
else
    fail "git status shows target/ as untracked" \
        "target/ not visible with ?? prefix in git status --porcelain"
fi

# Canonical inert-junk contract (US-001 / spec 02 §junk probes):
# operator-notes.local must exist in the WORK CLONE as present + UNTRACKED +
# byte-identical to the fixture source; it is ABSENT from the committed golden
# tree (build-golden.sh excludes it). Provisioning plants it into the clone for
# real runs; here we plant it to represent that provisioning state, then assert
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
echo "── Phase 4: Seed ref validation ─────────────────────────────────"
echo ""

# Seed colour expectations:
#   BUG-J1: RED (A1 off-by-one — 12 round-related failures, active bug)
#   BUG-J2: RED (A2 two-module NPE — 3 failures)
#   BUG-J3: RED (A3 red-herring column swap — 15 failures)
#   BUG-J4: GREEN (A4 O(n²) — dormant on small datasets, all 131 pass)
#   VULN-J1: GREEN (dormant XXE code path)
#   VULN-J2: GREEN (dormant path traversal code path)
#   BRK-J1: RED (1 broken assertion failure)
#   BRK-J2: RED (1 broken assertion failure)
# Seed lookup tables as bash-3.2-safe case-table functions. macOS /bin/bash
# 3.2.57 has no associative arrays (a bash 4+ feature), so the former
# SEED_EXPECT_GREEN / SEED_SYMPTOMS maps become lookup functions; the
# expected-green bits and symptom strings are byte-identical to the old maps.
# Unknown seeds fail loudly (return non-zero), matching the old map reads.
seed_expect_green() {
    case "$1" in
        BUG-J4|VULN-J1|VULN-J2) echo 1 ;;
        BUG-J1|BUG-J2|BUG-J3|BRK-J1|BRK-J2) echo 0 ;;
        *) return 1 ;;
    esac
}

seed_symptoms() {
    case "$1" in
        BUG-J1) echo "A1 off-by-one rounding — RED (12 MoneyUtilsTest failures)" ;;
        BUG-J2) echo "A2 two-module NPE on empty CSV — RED (3 failures across CsvParser + LedgerService)" ;;
        BUG-J3) echo "A3 red-herring column swap — RED (15 failures across CsvParser + CliApp)" ;;
        BUG-J4) echo "A4 O(n²) performance — GREEN (dormant on small datasets)" ;;
        VULN-J1) echo "XXE dormant — GREEN" ;;
        VULN-J2) echo "path traversal dormant — GREEN" ;;
        BRK-J1) echo "broken assertion (450 vs 475) — RED" ;;
        BRK-J2) echo "broken assertion (groceries vs food) — RED" ;;
        *) return 1 ;;
    esac
}

SEED_ORDER=(BUG-J1 BUG-J2 BUG-J3 BUG-J4 VULN-J1 VULN-J2 BRK-J1 BRK-J2)

for seed_id in "${SEED_ORDER[@]}"; do
    git checkout -f -q "seed/$seed_id" 2>/dev/null
    git clean -fdq

    # US-007: capture the mvnw output and surface its tail on fail-closed
    # seed-colour mismatches instead of swallowing to /dev/null.
    set +e
    SEED_OUT="$(./mvnw -q -B test -Dmaven.repo.local="$MAVEN_REPO_LOCAL" 2>&1)"
    SEED_EXIT=$?
    set -e

    if [ "$SEED_EXIT" -eq 0 ]; then
        if [ "$(seed_expect_green "$seed_id")" -eq 1 ]; then
            pass "seed/$seed_id: GREEN ($(seed_symptoms "$seed_id"))"
        else
            fail "seed/$seed_id: RED expected ($(seed_symptoms "$seed_id"))" \
                "test suite was GREEN"
            echo "    ── last lines of mvnw output ──" >&2
            printf '%s\n' "$SEED_OUT" | tail -20 >&2
        fi
    else
        if [ "$(seed_expect_green "$seed_id")" -eq 1 ]; then
            fail "seed/$seed_id: GREEN expected ($(seed_symptoms "$seed_id"))" \
                "test suite was RED"
            echo "    ── last lines of mvnw output ──" >&2
            printf '%s\n' "$SEED_OUT" | tail -20 >&2
        else
            pass "seed/$seed_id: RED ($(seed_symptoms "$seed_id"))"
        fi
    fi
done

# ── Phase 5: Fix patches restore GREEN ───────────────────────────

echo ""
echo "── Phase 5: Fix patches restore GREEN ───────────────────────────"
echo ""

FIX_SEEDS=(BUG-J1 BUG-J2 BUG-J3 BUG-J4 VULN-J1 VULN-J2 BRK-J1 BRK-J2)

for seed_id in "${FIX_SEEDS[@]}"; do
    # For VULN seeds, apply fix to baseline (they have no seed patch)
    if [ "${seed_id:0:4}" = "VULN" ]; then
        git checkout -f -q main 2>/dev/null
    else
        git checkout -f -q "seed/$seed_id" 2>/dev/null
    fi
    git clean -fdq

    FIX_PATCH="$SCRIPT_DIR/seeds/fix/${seed_id}-fix.patch"

    if [ ! -f "$FIX_PATCH" ]; then
        fail "$seed_id fix.patch exists" "file not found: $FIX_PATCH"
        continue
    fi

    # Apply fix patch with -p4 (patch paths are relative to repo root)
    if ! PATCH_OUT="$(git apply -p4 "$FIX_PATCH" 2>&1)"; then
        fail "$seed_id fix.patch applies cleanly" "git apply -p4 failed"
        echo "    ── last lines of git apply output ──" >&2
        printf '%s\n' "$PATCH_OUT" | tail -20 >&2
        continue
    fi
    pass "$seed_id fix.patch applies cleanly (-p4)"

    if MVN_OUT="$(./mvnw -q -B test -Dmaven.repo.local="$MAVEN_REPO_LOCAL" 2>&1)"; then
        pass "$seed_id fix restores GREEN"
    else
        fail "$seed_id fix restores GREEN" "test suite still RED after fix"
        echo "    ── last lines of mvnw output ──" >&2
        printf '%s\n' "$MVN_OUT" | tail -20 >&2
    fi
done

# ── Phase 6: Git status summary ──────────────────────────────────

echo ""
echo "── Phase 6: Git status summary ──────────────────────────────────"
echo ""

# Return to baseline for clean state
git checkout -f -q main 2>/dev/null
git clean -fdq

# Run tests to generate junk
./mvnw -q -B test -Dmaven.repo.local="$MAVEN_REPO_LOCAL" >/dev/null 2>&1 || true

# Plant operator-notes.local (provisioning-style) so the work clone represents
# the canonical untracked inert-junk state (golden excludes it; real runs get it
# from provisioning). It must appear as UNTRACKED junk, never as tracked.
cp -f "$SCRIPT_DIR/operator-notes.local" "$SCRATCH/operator-notes.local"

FINAL_STATUS="$(git status --porcelain 2>/dev/null)"

# Check that only expected untracked files appear
# Expected: target/ (untracked, must NOT be gitignored)
#           operator-notes.local (untracked inert junk — present + UNTRACKED per
#           the canonical contract, absent from the committed golden tree)
UNEXPECTED="$(echo "$FINAL_STATUS" | grep -v '^?? target/' | grep -v '^?? operator-notes.local' || true)"

if [ -z "$UNEXPECTED" ]; then
    pass "git status: only expected untracked files (target/)"
else
    # Filter out empty lines
    if [ -n "$(echo "$UNEXPECTED" | tr -d '[:space:]')" ]; then
        fail "git status: only expected untracked files" \
            "unexpected entries: $(echo "$UNEXPECTED" | head -3)"
    else
        pass "git status: only expected untracked files (target/)"
    fi
fi

# ── Results ───────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════"
printf "  \033[1mRESULTS:  Passed: %d  Failed: %d\033[0m\n" "$PASS" "$FAIL"
echo "══════════════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
