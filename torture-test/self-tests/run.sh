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
  run_test_file "scripted-runtime $base" "$file"
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
  run_test_file "tt-poly $base" "$file"
done

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
