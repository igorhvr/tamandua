#!/usr/bin/env bash
# verify-builder-determinism.test.sh — Self-test for golden builder determinism
#
# Exercises: all 7 build-golden.sh scripts produce deterministic output.
# Verifies:
#   - Hash files exist and are well-formed (BASELINE + SEED entries)
#   - Fast fixtures produce identical hashes on two consecutive rebuilds
#   - All fixtures pass their built-in determinism check on re-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_SRC="$REPO_ROOT/torture-test/fixtures-src"
GOLDEN="$REPO_ROOT/torture-test/var/fixtures/golden"

FAILURES=0
PASSES=0

pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# ── Fixture metadata ───────────────────────────────────────────────
declare -A FIXTURE_NAMES
FIXTURE_NAMES=(
    [tt-go]=tt-go.git.hashes
    [tt-java]=tt-java.git.hashes
    [tt-python]=tt-python.git.hashes
    [tt-python@master]=.build-hashes-tt-python-master
    [tt-rust]=tt-rust.git.hashes
    [tt-ts]=tt-ts.git.hashes
    [tt-poly-lite]=.build-hashes-tt-poly-lite
)

# ── Fast fixtures for full rebuild test (sub-30-second builds) ─────
readonly FAST_FIXTURES=(
    tt-python
    tt-python@master
    tt-go
)

echo "=== verify-builder-determinism.test.sh ==="

# ── Test group 1: All hash files exist ─────────────────────────────
echo ""
echo "--- Hash file existence ---"
for fixture in "${!FIXTURE_NAMES[@]}"; do
    hash_file="${FIXTURE_NAMES[$fixture]}"
    if [ -f "$GOLDEN/$hash_file" ]; then
        pass "$fixture: $hash_file exists"
    else
        fail "$fixture: $hash_file MISSING — rebuild any fixture first"
    fi
done

# ── Test group 2: Hash files are well-formed ───────────────────────
echo ""
echo "--- Hash file format ---"
for fixture in "${!FIXTURE_NAMES[@]}"; do
    hash_file="$GOLDEN/${FIXTURE_NAMES[$fixture]}"
    
    # Must have a baseline entry
    if grep -qE '^(BASELINE|baseline)' "$hash_file" 2>/dev/null; then
        pass "$fixture: has baseline entry"
    else
        fail "$fixture: missing baseline entry"
        continue
    fi
    
    # Must have seed entries
    seed_count=$(grep -cE '^(SEED |seed/)' "$hash_file" 2>/dev/null || true)
    if [ "${seed_count:-0}" -gt 0 ] 2>/dev/null; then
        pass "$fixture: $seed_count seed entries"
    else
        fail "$fixture: no seed entries found"
    fi
    
    # No empty lines
    if grep -q '^$' "$hash_file" 2>/dev/null; then
        fail "$fixture: contains empty lines"
    else
        pass "$fixture: no empty lines"
    fi
    
    # Every line has a commit hash (40 hex chars)
    bad_lines=$(grep -vE '[0-9a-f]{40}' "$hash_file" 2>/dev/null | grep -v '^$' || true)
    if [ -z "${bad_lines:-}" ]; then
        pass "$fixture: all lines contain valid hashes"
    else
        fail "$fixture: lines without valid hash: ${bad_lines:0:100}"
    fi
done

# ── Test group 3: Built-in determinism check on all fixtures ──────
echo ""
echo "--- Built-in determinism check (all fixtures) ---"
for fixture in "${!FIXTURE_NAMES[@]}"; do
    set +e
    output=$(bash "$FIXTURES_SRC/$fixture/build-golden.sh" 2>&1)
    exit_code=$?
    set -e
    
    if [ "$exit_code" -ne 0 ]; then
        fail "$fixture: build failed (exit $exit_code)"
        continue
    fi
    
    if echo "$output" | grep -qi "PASS\|IDENTICAL"; then
        pass "$fixture: determinism PASS reported"
    else
        fail "$fixture: no determinism PASS/IDENTICAL in output"
    fi
done

# ── Test group 4: Fast-fixture full rebuild determinism ────────────
echo ""
echo "--- Fast-fixture rebuild determinism ---"
for fixture in "${FAST_FIXTURES[@]}"; do
    hash_file="$GOLDEN/${FIXTURE_NAMES[$fixture]}"
    
    # Delete hash file for fresh first run
    rm -f "$hash_file"
    
    # Run 1
    if ! bash "$FIXTURES_SRC/$fixture/build-golden.sh" > /dev/null 2>&1; then
        fail "$fixture: Run 1 build FAILED"
        continue
    fi
    
    if [ ! -f "$hash_file" ]; then
        fail "$fixture: Run 1 did not produce hash file"
        continue
    fi
    
    hash1=$(sha256sum "$hash_file" | cut -d' ' -f1)
    
    # Run 2
    output2=$(bash "$FIXTURES_SRC/$fixture/build-golden.sh" 2>&1)
    
    if [ ! -f "$hash_file" ]; then
        fail "$fixture: Run 2 did not produce hash file"
        continue
    fi
    
    hash2=$(sha256sum "$hash_file" | cut -d' ' -f1)
    
    if [ "$hash1" = "$hash2" ]; then
        pass "$fixture: identical hash files (sha256 match)"
    else
        fail "$fixture: hash files differ between runs"
    fi
    
    # Verify the builder reported success
    if echo "$output2" | grep -qi "PASS\|IDENTICAL"; then
        pass "$fixture: builder reported determinism"
    else
        fail "$fixture: builder did not report determinism PASS"
    fi
done

# ── Summary ────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Result: $PASSES pass, $FAILURES fail"
if [ "$FAILURES" -gt 0 ]; then
    echo "FAILED"
    exit 1
else
    echo "PASSED"
fi
