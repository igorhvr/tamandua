#!/usr/bin/env bash
# Probe: BUG-J1 — off-by-one rounding scale (setScale(scale-1, mode))
# Fixture: tt-java
# Task type: bug (A1 — off-by-one)
#
# Checks:
#   1. MoneyUtils.round() uses setScale(scale, mode), not setScale(scale-1, mode)
#   2. Regression test exists for boundary round (2.445 → 2.45)
#   3. Revert-probe: apply seed patch → regression test fails

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

SEEDS_DIR="$(cd "$(dirname "$0")/../../../fixtures-src/tt-java/seeds" && pwd)"
SEED_PATCH="$SEEDS_DIR/BUG-J1.patch"

# ── 1. No off-by-one in MoneyUtils.round() ──
echo "[] Checking MoneyUtils.round() for off-by-one scale..." >&2
MONEY_UTILS="$WORKSPACE/src/main/java/com/tamandua/ledger/MoneyUtils.java"
check_file_exists "$MONEY_UTILS" "MoneyUtils.java not found in workspace"

assert_not_grep 'setScale(scale - 1' "$MONEY_UTILS" \
    "BUG-J1 not fixed: setScale(scale-1, mode) still present in MoneyUtils.java"

assert_grep 'setScale(scale' "$MONEY_UTILS" \
    "BUG-J1 not fixed: setScale(scale, mode) not found in MoneyUtils.java"

# ── 2. Regression test exists ──
echo "[] Checking for regression test..." >&2
check_regression_test "$WORKSPACE" "regressionBugJ1\|regressionBugJ1ScalePreserved" \
    "BUG-J1: no regression test found for boundary round scale preservation"

# ── 3. Revert-probe: apply seed patch → regression test must fail ──
echo "[] Running revert-probe..." >&2
REVERT_SCRATCH="$SCRATCH/revert-bug-j1"
rm -rf "$REVERT_SCRATCH"
cp -a "$WORKSPACE" "$REVERT_SCRATCH"

if ! (cd "$REVERT_SCRATCH" && git apply --verbose -p4 "$SEED_PATCH" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    infra_error "BUG-J1 revert-probe: failed to apply seed patch"
fi

# Run the regression test — must fail (bug re-introduced, scale off-by-one)
if (cd "$REVERT_SCRATCH" && ./mvnw -q -B test -Dtest="MoneyUtilsTest#regressionBugJ1ScalePreserved" 2>&1); then
    rm -rf "$REVERT_SCRATCH"
    fail "revert-probe: MoneyUtils regression test passed after re-introducing BUG-J1 bug — probe is not catching the regression"
fi

rm -rf "$REVERT_SCRATCH"
echo "[] Revert-probe passed: regression test caught the re-introduced bug" >&2

pass_ "BUG-J1: no off-by-one rounding scale, regression test exists, revert-probe passed"
