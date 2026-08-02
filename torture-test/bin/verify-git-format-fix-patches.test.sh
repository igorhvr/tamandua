#!/usr/bin/env bash
# verify-git-format-fix-patches.test.sh — Self-test for git-format fix patch verification
#
# Exercises: git apply -p4 --check on all 24 git-format fix patches across
# tt-java (8), tt-ts (8), and tt-poly-lite/ts (8) fixtures.
# Verifies:
#   - BUG/BRK patches apply to their respective seed branches
#   - VULN patches apply to main (dormant vuln convention)
#   - POLY-BUG-T4-fix.patch with reversed b/a headers applies correctly
#   - TT-ts BUG-T1..T4 patches on same files apply individually
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_SRC="$REPO_ROOT/torture-test/fixtures-src"
GOLDEN="$REPO_ROOT/torture-test/var/fixtures/golden"

FAILURES=0
PASSES=0
WORKDIRS=()

pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
    for d in "${WORKDIRS[@]}"; do
        rm -rf "$d" 2>/dev/null || true
    done
}
trap cleanup EXIT

# ── verify_patch: git apply -p4 --check on a specific branch ──────
verify_patch() {
    local bare_path="$1"
    local patch_path="$2"
    local branch="$3"
    local label="$4"
    local workdir
    workdir=$(mktemp -d "/tmp/verify-fix-XXXXXX")
    WORKDIRS+=("$workdir")

    if ! git clone "$bare_path" -b "$branch" "$workdir" 2>/dev/null; then
        fail "$label — clone failed (branch=$branch)"
        return 1
    fi

    if git -C "$workdir" apply -p4 --check "$patch_path" 2>/dev/null; then
        pass "$label"
    else
        local err
        err=$(git -C "$workdir" apply -p4 --check "$patch_path" 2>&1 || true)
        fail "$label — ${err:0:150}"
        return 1
    fi
}

# ── Test setup: check golden bares exist ───────────────────────────
for bare in tt-java.git tt-ts.git tt-poly-lite.git; do
    if [ ! -d "$GOLDEN/$bare" ]; then
        echo "ERROR: Golden bare not found: $GOLDEN/$bare"
        echo "Run build-golden.sh scripts first."
        exit 1
    fi
done

echo "=== verify-git-format-fix-patches.test.sh ==="

# ── tt-java (8 patches) ────────────────────────────────────────────
echo ""
echo "--- tt-java ---"
for id in BRK-J1 BRK-J2 BUG-J1 BUG-J2 BUG-J3 BUG-J4; do
    verify_patch "$GOLDEN/tt-java.git" \
        "$FIXTURES_SRC/tt-java/seeds/fix/${id}-fix.patch" \
        "seed/$id" \
        "tt-java ${id}-fix.patch"
done
for id in VULN-J1 VULN-J2; do
    verify_patch "$GOLDEN/tt-java.git" \
        "$FIXTURES_SRC/tt-java/seeds/fix/${id}-fix.patch" \
        "main" \
        "tt-java ${id}-fix.patch (on main)"
done

# ── tt-ts (8 patches) ──────────────────────────────────────────────
echo ""
echo "--- tt-ts ---"
for id in BRK-T1 BRK-T2 BUG-T1 BUG-T2 BUG-T3 BUG-T4; do
    verify_patch "$GOLDEN/tt-ts.git" \
        "$FIXTURES_SRC/tt-ts/seeds/fix/${id}-fix.patch" \
        "seed/$id" \
        "tt-ts ${id}-fix.patch"
done
for id in VULN-T1 VULN-T2; do
    verify_patch "$GOLDEN/tt-ts.git" \
        "$FIXTURES_SRC/tt-ts/seeds/fix/${id}-fix.patch" \
        "main" \
        "tt-ts ${id}-fix.patch (on main)"
done

# ── tt-poly-lite/ts (8 patches) ─────────────────────────────────────
echo ""
echo "--- tt-poly-lite/ts ---"
for id in POLY-BRK-T1 POLY-BRK-T2 POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4; do
    verify_patch "$GOLDEN/tt-poly-lite.git" \
        "$FIXTURES_SRC/tt-poly-lite/ts/seeds/fix/${id}-fix.patch" \
        "seed/$id" \
        "tt-poly-lite/ts ${id}-fix.patch"
done
for id in POLY-VULN-T1 POLY-VULN-T2; do
    verify_patch "$GOLDEN/tt-poly-lite.git" \
        "$FIXTURES_SRC/tt-poly-lite/ts/seeds/fix/${id}-fix.patch" \
        "main" \
        "tt-poly-lite/ts ${id}-fix.patch (on main)"
done

# ── Special: POLY-BUG-T4 reversed b/a headers ──────────────────────
echo ""
echo "--- Special case: POLY-BUG-T4 reversed b/a headers ---"
workdir=$(mktemp -d "/tmp/verify-fix-XXXXXX")
WORKDIRS+=("$workdir")
git clone "$GOLDEN/tt-poly-lite.git" -b "seed/POLY-BUG-T4" "$workdir" 2>/dev/null
patch_path="$FIXTURES_SRC/tt-poly-lite/ts/seeds/fix/POLY-BUG-T4-fix.patch"

# Verify the patch has reversed b/a headers
if head -1 "$patch_path" | grep -q "b/torture-test.*a/torture-test"; then
    pass "POLY-BUG-T4-fix.patch has reversed b/a headers (as expected)"
else
    fail "POLY-BUG-T4-fix.patch does NOT have reversed headers"
fi

# Verify it applies correctly
if git -C "$workdir" apply -p4 "$patch_path" 2>/dev/null; then
    pass "POLY-BUG-T4-fix.patch applies correctly with reversed headers"
else
    fail "POLY-BUG-T4-fix.patch failed to apply"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=== SUMMARY ==="
echo "Passed: $PASSES, Failed: $FAILURES, Total: $((PASSES + FAILURES))"

if [ "$FAILURES" -gt 0 ]; then
    echo "Some tests FAILED — see output above."
    exit 1
fi

echo "All tests PASSED."
exit 0
