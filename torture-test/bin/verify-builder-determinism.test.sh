#!/usr/bin/env bash
# verify-builder-determinism.test.sh — Self-test for golden builder determinism
#
# US-006 (E2.4): regenerates affected goldens + hash ledgers exactly once, then
# proves determinism — two consecutive full builds MUST produce byte-identical
# goldens AND identical hash ledgers.
#
# Every fixture is built TWICE into an ISOLATED temp TORTURE_GOLDEN_DIR. The two
# resulting golden dirs (bare repo + hash ledger) are fingerprinted and compared:
# they must be byte-identical. The test NEVER writes to the real
# torture-test/var/fixtures/golden dir, so it is non-destructive, order-independent,
# and self-contained (no dependence on pre-built goldens).
#
# Covers ALL EIGHT fixtures with their canonical ledger filenames (matching
# tt-golden-bootstrap.mjs FIXTURE_META — tt-python@master records to
# `.build-hashes-tt-python-master`, not `<name>.git.hashes`).
#
# Note: this is a HEAVY hermetic gate (every fixture is built twice from
# scratch, tt-poly dominates). It is NOT part of self-tests/run.sh; run it
# explicitly to certify builder determinism or before a real launch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_SRC="$REPO_ROOT/torture-test/fixtures-src"

FAILURES=0
PASSES=0
pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# ── All eight fixtures → canonical determinism-ledger filename ──────
# Names MUST stay in lock-step with bin/tt-golden-bootstrap.mjs FIXTURE_META
# (the single source of truth for ledger filenames).
declare -A FIXTURE_HASH
FIXTURE_HASH=(
    [tt-go]=tt-go.git.hashes
    [tt-java]=tt-java.git.hashes
    [tt-poly]=tt-poly.git.hashes
    [tt-poly-lite]=tt-poly-lite.git.hashes
    [tt-python]=tt-python.git.hashes
    [tt-python@master]=.build-hashes-tt-python-master
    [tt-rust]=tt-rust.git.hashes
    [tt-ts]=tt-ts.git.hashes
)

# Fingerprint the produced golden dir: sha256 of every file, sorted by name.
# This captures BOTH the bare repo object bytes and the hash ledger. Temp
# scratch dirs are cleaned by each builder's EXIT trap, so nothing non-golden
# should remain after a build; defensively drop any `.scratch*`/`.hashes*`/
# `tmp.build-golden*` leftovers so transient artifacts can never mask a real
# determinism regression.
fingerprint() {
    local dir="$1"
    ( cd "$dir" 2>/dev/null \
        && find . -type f \
               ! -path '*/.scratch*' \
               ! -name '.hashes.*' \
               ! -name '.hashes-*' \
               ! -name 'tmp.build-golden*' \
               -exec sha256sum {} \; | sort -k2 )
}

verify_ledger() {
    # Minimal well-formedness: a baseline entry (either format) and at least one
    # seed/ref entry, with every value a 40-hex object id.
    local hash_file="$1"
    [ -s "$hash_file" ] || return 1
    grep -qE '^(BASELINE|baseline)[ =].*[0-9a-f]{40}' "$hash_file" || return 1
    grep -qE '^(SEED |seed/)' "$hash_file" || return 1
    # every non-empty line carries a 40-hex object id
    ! grep -vE '[0-9a-f]{40}' "$hash_file" | grep -qv '^$' || return 1
    return 0
}

echo "=== verify-builder-determinism.test.sh (US-006) ==="
echo "Hermetic 2-build byte-identity proof for ALL $(( ${#FIXTURE_HASH[@]} )) fixtures."
echo "Each fixture is built twice into an isolated temp TORTURE_GOLDEN_DIR; the two"
echo "produced golden dirs (bare + hash ledger) must be byte-identical. The real"
echo "torture-test/var golden dir is never touched."

for fixture in tt-go tt-java tt-poly tt-poly-lite tt-python tt-python@master tt-rust tt-ts; do
    hash_file="${FIXTURE_HASH[$fixture]}"
    golden_dir="$(mktemp -d "${TMPDIR:-/tmp}/torture-determinism.XXXXXX")"

    b1log="$(mktemp "${TMPDIR:-/tmp}/determinism-$fixture-b1.XXXXXX")"
    b2log="$(mktemp "${TMPDIR:-/tmp}/determinism-$fixture-b2.XXXXXX")"

    # ── Build 1 (regeneration) ──────────────────────────────────────
    if ! TORTURE_GOLDEN_DIR="$golden_dir" bash "$FIXTURES_SRC/$fixture/build-golden.sh" > "$b1log" 2>&1; then
        fail "$fixture: build 1 FAILED"
        tail -12 "$b1log" | sed 's/^/    /'
        rm -rf "$golden_dir" "$b1log" "$b2log"
        continue
    fi
    if [ ! -f "$golden_dir/$hash_file" ]; then
        fail "$fixture: build 1 produced no hash ledger '$hash_file'"
        tail -12 "$b1log" | sed 's/^/    /'
        rm -rf "$golden_dir" "$b1log" "$b2log"
        continue
    fi
    if ! verify_ledger "$golden_dir/$hash_file"; then
        fail "$fixture: build 1 hash ledger is malformed"
        rm -rf "$golden_dir" "$b1log" "$b2log"
        continue
    fi
    snapshot1="$(fingerprint "$golden_dir")"

    # ── Build 2 (determinism: identical result) ─────────────────────
    if ! TORTURE_GOLDEN_DIR="$golden_dir" bash "$FIXTURES_SRC/$fixture/build-golden.sh" > "$b2log" 2>&1; then
        fail "$fixture: build 2 FAILED"
        tail -12 "$b2log" | sed 's/^/    /'
        rm -rf "$golden_dir" "$b1log" "$b2log"
        continue
    fi
    snapshot2="$(fingerprint "$golden_dir")"

    if [ "$snapshot1" = "$snapshot2" ]; then
        pass "$fixture: two consecutive hermetic builds byte-identical (golden + ledger)"
    else
        fail "$fixture: two builds DIFFER (determinism regression)"
        echo "    diff (build1 vs build2 golden dir):"
        diff <(echo "$snapshot1") <(echo "$snapshot2") | sed 's/^/      /' | head -20
    fi

    # Builder must self-report determinism on the SECOND (comparison) run.
    if grep -qi 'PASS\|IDENTICAL' "$b2log"; then
        pass "$fixture: builder reported determinism PASS on re-run"
    else
        fail "$fixture: builder did not report determinism PASS on re-run"
    fi

    rm -rf "$golden_dir" "$b1log" "$b2log"
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
