#!/usr/bin/env bash
# run.sh — self-tests for relocated torture-test files.
#
# Invokes all scripted-runtime and tt-poly test files that live under
# torture-test/self-tests/.  Each file is run serially via node --test
# (node >= 22 runs .ts directly; no build step, no new deps).  The
# script exits non-zero on any failure.
#
# Must pass twice consecutively (idempotent — each run uses fresh temp dirs).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF_DIR="$REPO_ROOT/torture-test/self-tests"
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"

cd "$REPO_ROOT"

PASS=0
FAIL=0

# --- helpers ---

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

# ── Git status cleanliness guard ──────────────────────────────────
# Capture git status --porcelain BEFORE tests so we can detect any
# test that dirties the working tree (build artifacts, cache files,
# etc.).  If the tree is dirty when run.sh starts, the guard fails
# immediately so we never blame tests for pre-existing dirt.
GIT_BEFORE_FILE="$(mktemp "${TMPDIR:-/tmp}/run-sh-git-before.XXXXXX")"
GIT_AFTER_FILE="$(mktemp "${TMPDIR:-/tmp}/run-sh-git-after.XXXXXX")"

# EXIT trap MUST be set before any capture so the temp files are
# cleaned up even on early failure (set -e).
cleanup_git_snapshots() {
  rm -f -- "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE"
}
trap cleanup_git_snapshots EXIT

git status --porcelain > "$GIT_BEFORE_FILE"
if [ -s "$GIT_BEFORE_FILE" ]; then
  red "ERROR: working tree is dirty before any tests ran.  Refusing to proceed."
  red "Dirty files:"
  cat "$GIT_BEFORE_FILE" >&2
  exit 1
fi

pass() { green "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { red "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# --- test runner ---

run_test_file() {
  local label="$1" file="$2"

  if [ ! -f "$file" ]; then
    fail "$label" "file not found: $file"
    return 1
  fi

  if "$NODE_BIN" --test "$file" 2>&1; then
    pass "$label"
    return 0
  else
    fail "$label" "node --test exited non-zero"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

echo "=== run.sh — torture-test self-tests ==="
echo ""

# ── Scripted-runtime tests ────────────────────────────────────────
echo "--- scripted-runtime tests ---"
for file in "$SELF_DIR"/scripted-runtime-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "scripted-runtime glob" "no files matching $SELF_DIR/scripted-runtime-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "scripted-runtime $base" "$file" || true
done

# ── Scripted-scenario harness tests ───────────────────────────────
echo ""
echo "--- scripted-scenario tests ---"
for file in "$SELF_DIR"/scripted-scenario-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "scripted-scenario glob" "no files matching $SELF_DIR/scripted-scenario-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "scripted-scenario $base" "$file" || true
done

# ── Tier-0 manifest and repeatability acceptance tests ────────────
echo ""
echo "--- tier0 tests ---"
for file in "$SELF_DIR"/tier0-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tier0 glob" "no files matching $SELF_DIR/tier0-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "tier0 $base" "$file" || true
done

# ── Tier-1 manifest and repeatability acceptance tests ────────────
echo ""
echo "--- tier1 tests ---"
for file in "$SELF_DIR"/tier1-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tier1 glob" "no files matching $SELF_DIR/tier1-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "tier1 $base" "$file" || true
done

# ── tt-poly tests ─────────────────────────────────────────────────
echo ""
echo "--- tt-poly tests ---"
for file in "$SELF_DIR"/tt-poly-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tt-poly glob" "no files matching $SELF_DIR/tt-poly-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "tt-poly $base" "$file" || true
done

# ── Git status cleanliness check ─────────────────────────────────
echo ""
echo "--- git status cleanliness ---"

git status --porcelain > "$GIT_AFTER_FILE"
if diff -q "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE" > /dev/null 2>&1; then
  green "Working tree: clean"
else
  red "ERROR: working tree is DIRTY after test run — tests wrote build artifacts"
  red "Files that appeared or changed during the run:"
  diff "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE" >&2 || true
  FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
