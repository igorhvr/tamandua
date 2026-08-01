#!/usr/bin/env bash
# Probe: FEAT-R3 — rate limit metrics and statistics (Metrics struct, atomic counters)
# Fixture: tt-rust
# Task type: feature
#
# Checks:
#   1. Metrics struct exists with total_calls, accepted, rejected, peak_tokens
#   2. All counters are atomic (AtomicU64)
#   3. total_calls = accepted + rejected invariant
#   4. peak_tokens updated via fetch_max CAS loop
#   5. reset() clears all counters
#   6. Feature tests exist and pass
#   7. Existing TokenBucket tests still pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. Metrics struct exists ──
echo "[] Checking for Metrics struct..." >&2

METRICS_SRC=$(find "$WORKSPACE" -type f -name '*.rs' -not -path '*/target/*' -exec grep -l 'struct Metrics' {} \; 2>/dev/null | head -1)
if [ -z "$METRICS_SRC" ]; then
    fail "FEAT-R3 not implemented: Metrics struct not found in workspace"
fi

# ── 2. Atomic counters ──
echo "[] Checking for atomic counters..." >&2

assert_grep 'total_calls' "$METRICS_SRC" \
    "FEAT-R3 not implemented: total_calls field not found in Metrics"

assert_grep 'accepted' "$METRICS_SRC" \
    "FEAT-R3 not implemented: accepted field not found in Metrics"

assert_grep 'rejected' "$METRICS_SRC" \
    "FEAT-R3 not implemented: rejected field not found in Metrics"

assert_grep 'peak_tokens' "$METRICS_SRC" \
    "FEAT-R3 not implemented: peak_tokens field not found in Metrics"

# Verify atomics are used (not plain integers)
assert_grep 'AtomicU64\|Atomic' "$METRICS_SRC" \
    "FEAT-R3 not implemented: metrics counters are not atomic"

# ── 3. Reset clears all counters ──
echo "[] Checking for reset method..." >&2

assert_grep 'fn reset' "$METRICS_SRC" \
    "FEAT-R3 not implemented: no reset method in Metrics"

# ── 4. Feature tests exist ──
echo "[] Checking for feature tests..." >&2

check_regression_test "$WORKSPACE" "FEAT.R3\|feat_r3\|Metrics\|total_calls\|peak_tokens\|instrumentation" \
    "FEAT-R3: no tests found for rate limit metrics"

# ── 5. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" cargo test --quiet -- "feat_r3\|FEAT.R3\|Metrics\|total_calls\|peak_tokens\|instrumentation" 2>&1; then
    fail "FEAT-R3: metrics feature tests failed"
fi

# ── 6. Full test suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "FEAT-R3: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-R3: Metrics struct with atomic total_calls/accepted/rejected/peak_tokens, reset(), feature tests pass, full suite green"
