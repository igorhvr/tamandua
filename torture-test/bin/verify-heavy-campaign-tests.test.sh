#!/usr/bin/env bash
# verify-heavy-campaign-tests.test.sh — Isolated invocation of the heavy
# zero-token campaign self-tests.
#
# US-006 (E2.4) harness-closure: e2e-golden-integrity.test.ts AC1 reproducibly
# timed out because a single run.sh of the full zero-token battery legitimately
# exceeded the wrapper's deadline: tier0-repeatability runs two full
# scripted-daemon campaigns, and tier1-repeatability / tier1-real-case-proof /
# tier1-include-real-proof / tier1-zero-real-launch-infra / tier1-case-filter /
# scripted-scenario-harness drive full campaign machinery that can exceed 60+
# minutes of ACTIVE progress (writing scenario git objects) on a contended
# machine. When run.sh's aggregate deadline fired it SIGTERM'd run.sh but
# ORPHANED the campaign's daemon/tt-controller grandchildren (reparented to
# init), which kept running, leaked ports (5334/5338/5339), and broke sibling
# tests (scripted-scenario-harness EADDRINUSE) until manually cleaned.
#
# These tests are therefore NOT part of self-tests/run.sh. Each is executed
# HERE as its OWN isolated `node --test` process, under its OWN generous
# per-test ceiling and with NO aggregate deadline over the concatenation, so:
#   (1) run.sh completes in a bounded window regardless of machine load, and
#   (2) a single timed-out/isolated run can only orphan ITS OWN daemons — never
#       the battery — and is contained/attributable. This is the exact
#       verify-builder-determinism.test.sh pattern (a heavyweight gate kept out
#       of run.sh and run explicitly). Contention-independent. Zero tokens.
#
# Confined to torture-test/ (state under gitignored var/). The heavy list MUST
# stay in lock-step with self-tests/run.sh HEAVY_CAMPAIGN_TESTS and
# self-tests/e2e-golden-integrity.test.ts (which pins the invariant).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SELF_DIR="$REPO_ROOT/torture-test/self-tests"
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"

# Per-test ceiling only — there is intentionally NO aggregate total. Each heavy
# test drives an unbounded campaign; give it a generous IRON ceiling so we never
# kill it mid-progress on a contended machine. A ceiling hit (timeout, exit 124)
# is a FAIL for THAT test only and prefixes cleanup guidance; every other test is
# unaffected. Default 6h; override with TORTURE_HEAVY_PER_TEST_TIMEOUT_SEC.
#
# The default MUST NOT be below tier0-repeatability's own declared budget: it
# deliberately executes TWO full tier0 gates (each capped at 3h by the manifest;
# observed ~2.4h on this host), and its `it` block declares a 6h timeout. A 4h
# wrapper ceiling killed it mid-second-gate in every recorded run (E3.C.1
# US-008: the acceptance battery surfaced the mismatch) and the leaked daemon
# from the interrupted campaign then broke the next heavy test (include-real
# FINDINGS). 6h matches the test's own timeout and covers both gates.
PER_TEST_TIMEOUT_SEC="${TORTURE_HEAVY_PER_TEST_TIMEOUT_SEC:-21600}"

# MUST stay in lock-step with self-tests/run.sh HEAVY_CAMPAIGN_TESTS and
# self-tests/e2e-golden-integrity.test.ts.
HEAVY_TESTS=(
    'scripted-scenario-harness.test.ts'
    'tier0-repeatability.test.ts'
    'tier1-case-filter.test.ts'
    'tier1-e26-real-launch-proof.test.ts'
    'tier1-include-real-proof.test.ts'
    'tier1-real-case-proof.test.ts'
    'tier1-repeatability.test.ts'
    'tier1-scripted-probe-battery.test.ts'
    'tier1-kill-sentinel-survival.test.ts'
    'tier1-zero-real-launch-infra.test.ts'
    'tier2-repeatability.test.ts'
    'tier2-scripted-behaviors-materialization.test.ts'
)

FAILURES=0
PASSES=0
pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== verify-heavy-campaign-tests.test.sh ==="
echo "Running ${#HEAVY_TESTS[@]} heavy campaign self-tests INDIVIDUALLY."
echo "Each runs as its own process under its own ${PER_TEST_TIMEOUT_SEC}s ceiling (no aggregate deadline)."

for base in "${HEAVY_TESTS[@]}"; do
    file="$SELF_DIR/$base"
    if [ ! -f "$file" ]; then
        fail "$base: file not found ($file)"
        continue
    fi

    log="$(mktemp "${TMPDIR:-/tmp}/heavy-campaign.XXXXXX")"

    set +e
    if command -v timeout >/dev/null 2>&1; then
        timeout "$PER_TEST_TIMEOUT_SEC" "$NODE_BIN" --test "$file" > "$log" 2>&1
        rc=$?
    else
        "$NODE_BIN" --test "$file" > "$log" 2>&1
        rc=$?
    fi
    set -e

    if [ "$rc" -eq 0 ]; then
        pass "$base"
    elif [ "$rc" -eq 124 ]; then
        fail "$base: TIMED OUT after ${PER_TEST_TIMEOUT_SEC}s. Run it individually and clean any leaked"
        echo "       daemons on ports 5334/5338/5339 (e.g. pkill -f tt-controller) before rerunning."
        tail -20 "$log" | sed 's/^/    /'
    else
        fail "$base: node --test exited $rc (see tail below)"
        tail -20 "$log" | sed 's/^/    /'
    fi

    rm -f -- "$log"
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Result: $PASSES pass, $FAILURES fail"
if [ "$FAILURES" -gt 0 ]; then
    echo "FAILED"
    exit 1
else
    echo "PASSED"
fi
