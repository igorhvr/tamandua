#!/usr/bin/env bash
# Probe: FEAT-R2 — per-key IP rate limiting (RateLimiter<K> with HashMap<K, TokenBucket>)
# Fixture: tt-rust
# Task type: feature
#
# Checks:
#   1. RateLimiter<K: Eq + Hash> generic type exists
#   2. HashMap<K, TokenBucket> for per-key buckets
#   3. try_consume(key: &K, count: u32) -> bool exists
#   4. Lazy bucket creation on first access
#   5. Feature tests exist and pass
#   6. Existing TokenBucket tests still pass

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# ── 1. RateLimiter<K> generic type exists ──
echo "[] Checking for RateLimiter<K>..." >&2

LIMITER_SRC=$(find "$WORKSPACE" -type f -name '*.rs' -not -path '*/target/*' -exec grep -l 'struct RateLimiter' {} \; 2>/dev/null | head -1)
if [ -z "$LIMITER_SRC" ]; then
    fail "FEAT-R2 not implemented: RateLimiter struct not found in workspace"
fi

assert_grep 'RateLimiter.*<' "$LIMITER_SRC" \
    "FEAT-R2 not implemented: RateLimiter is not generic over K"

# ── 2. HashMap<K, TokenBucket> ──
echo "[] Checking for HashMap<K, TokenBucket>..." >&2

assert_grep 'HashMap<K.*TokenBucket\|HashMap<K.*ttrust' "$LIMITER_SRC" \
    "FEAT-R2 not implemented: no HashMap for per-key token buckets"

# ── 3. try_consume method with key parameter ──
echo "[] Checking for per-key try_consume method..." >&2

workspace_grep "$WORKSPACE" 'fn try_consume.*key\|fn try_consume.*K' 'src/' > /dev/null
if ! workspace_grep "$WORKSPACE" 'fn try_consume' 'src/' | grep -q 'key'; then
    fail "FEAT-R2 not implemented: no per-key try_consume method found"
fi

# ── 4. Lazy bucket creation ──
echo "[] Checking for lazy bucket creation..." >&2

assert_grep 'entry\|or_insert\|HashMap.*get\|contains_key' "$LIMITER_SRC" \
    "FEAT-R2 not implemented: no lazy bucket creation (entry/or_insert)"

# ── 5. Feature tests exist ──
echo "[] Checking for feature tests..." >&2

check_regression_test "$WORKSPACE" "FEAT.R2\|feat_r2\|per_key\|RateLimiter\|multiple_keys\|independent" \
    "FEAT-R2: no tests found for per-key rate limiting"

# ── 6. Feature tests pass ──
echo "[] Running feature tests..." >&2
if ! run_in_workspace "$WORKSPACE" cargo test --quiet -- "feat_r2\|FEAT.R2\|per_key\|RateLimiter" 2>&1; then
    fail "FEAT-R2: per-key rate limiting feature tests failed"
fi

# ── 7. Full test suite still passes (backward compatibility) ──
echo "[] Running full test suite..." >&2
if ! run_rust_tests "$WORKSPACE" 2>&1; then
    fail "FEAT-R2: full test suite has failures — may have broken backward compatibility"
fi

pass_ "FEAT-R2: RateLimiter<K> with HashMap<K, TokenBucket>, per-key try_consume, lazy creation, feature tests pass, full suite green"
