#!/usr/bin/env bash
# build-golden.sh — deterministic golden bare repo builder for tt-python
#
# Builds torture-test/var/fixtures/golden/tt-python.git from the fixture
# source.  Every commit hash is stable across rebuilds: fixed git author /
# committer identity and timestamps ensure byte-identical repos.
#
# Re-running the script prints hashes and fails if they diverge from the
# previous run — this acts as a self-check for deterministic behaviour.
#
# Usage:
#   bash torture-test/fixtures-src/tt-python/build-golden.sh
#
# Requirements: bash, git, rsync, python3 (for bootstrap + test
# verification in the scratch clone).

set -euo pipefail

# ── Deterministic git identity ─────────────────────────────────────
export GIT_AUTHOR_NAME="Tamandua Fixture Builder"
export GIT_AUTHOR_EMAIL="tamandua@fixtures.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VAR_DIR="$REPO_ROOT/torture-test/var"
FIXTURE_SRC="$SCRIPT_DIR"
GOLDEN_DIR="$VAR_DIR/fixtures/golden"
GOLDEN_BARE="$GOLDEN_DIR/tt-python.git"
HASH_FILE="$GOLDEN_DIR/.build-hashes"

# ── Create output directories ──────────────────────────────────────
mkdir -p "$GOLDEN_DIR"

# ── Clean up previous golden bare (rebuild is always from scratch) ─
rm -rf "$GOLDEN_BARE"

# ── Prepare work tree ──────────────────────────────────────────────
# Copy fixture source excluding generated crud that shouldn't be committed
# (.venv, mypy cache, bytecode, egg-info, pytest cache, flaky counter).
WORK_DIR="$(mktemp -d "$VAR_DIR/tmp.build-golden.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap cleanup_work EXIT

rsync -a \
    --exclude='.venv/' \
    --exclude='.mypy_cache/' \
    --exclude='__pycache__/' \
    --exclude='*.egg-info/' \
    --exclude='.pytest_cache/' \
    --exclude='.flaky_counter' \
    "$FIXTURE_SRC/" "$WORK_DIR/"

cd "$WORK_DIR"

# ── Seed-order list (defines tag ordering for reproducible iteration) ──
# The order is: bugs first (A1→A4), then vulns, then flaky.
# Broken tests live on their own branch and are not in this list.
readonly SEED_ORDER=(
    BUG-P1
    BUG-P2
    BUG-P3
    BUG-P4
    VULN-P1
    VULN-P2
    FLAKY-P1
)

# ── Initialize git repo and create baseline commit ─────────────────
# Use --initial-branch=main so the default branch is "main".
# The tt-python@master variant's build script will use --initial-branch=master.
git init -q --initial-branch=main
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
# GPG signing must be disabled — signatures are non-deterministic
git config commit.gpgsign false
git config tag.gpgsign false
git add -A
git commit -q -m "Initial baseline: tt-python fixture (green test suite)"
BASELINE_HASH="$(git rev-parse HEAD)"

# ── apply_one_seed ─────────────────────────────────────────────────
# Usage: apply_one_seed <seed-id>
#
# Checks out the green-baseline commit, copies the seed's overlay file(s)
# into place, and creates a single commit + tag on a detached HEAD.
# If no overlay files differ from baseline an --allow-empty commit is
# created (needed for dormant vuln seeds whose code already lives in
# baseline).
apply_one_seed() {
    local seed_id="$1"
    local seed_dir="$FIXTURE_SRC/seeds/$seed_id"

    # Start clean from baseline
    git checkout -qf "$BASELINE_HASH" 2>/dev/null
    git clean -fdq

    local changed=false
    for f in "$seed_dir"/*; do
        local fname
        fname="$(basename "$f")"
        # Skip fix.patch — it is not an overlay file
        [ "$fname" = "fix.patch" ] && continue

        local target
        case "$fname" in
            recurrence.py)   target="src/schedlib/recurrence.py" ;;
            conflict.py)     target="src/schedlib/conflict.py" ;;
            dates.py)        target="src/schedlib/dates.py" ;;
            integrations.py) target="src/schedlib/integrations.py" ;;
            conftest.py)     target="conftest.py" ;;
            *)
                echo "ERROR: unknown seed overlay file: $fname (seed $seed_id)" >&2
                exit 1
                ;;
        esac

        if ! diff -q "$f" "$target" >/dev/null 2>&1; then
            cp "$f" "$target"
            changed=true
        fi
    done

    if $changed; then
        git add -A
        git commit -q -m "seed: $seed_id"
    else
        git commit -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
    fi

    git tag "seed/$seed_id"
    printf "  seed/%-12s → %s\n" "$seed_id" "$(git rev-parse HEAD)"
}

# ── Build seed tags ────────────────────────────────────────────────
echo "═╡ build-golden: tt-python fixture ╞══════════════════════════════"
echo ""
echo "Baseline: $BASELINE_HASH"
echo ""
echo "Seed tags (each on top of baseline):"

for seed_id in "${SEED_ORDER[@]}"; do
    apply_one_seed "$seed_id"
done

# ── broken-tests branch ────────────────────────────────────────────
echo ""
echo "broken-tests branch (BRK-P1 + BRK-P2 on top of baseline):"

git checkout -qf "$BASELINE_HASH" 2>/dev/null
git clean -fdq
git checkout -qb broken-tests

cp "$FIXTURE_SRC/seeds/BRK-P1/test_broken_p1.py" "tests/test_broken_p1.py"
git add -A
git commit -q -m "seed: BRK-P1 (broken test — date mismatch)"
printf "  BRK-P1             → %s\n" "$(git rev-parse HEAD)"

cp "$FIXTURE_SRC/seeds/BRK-P2/test_broken_p2.py" "tests/test_broken_p2.py"
git add -A
git commit -q -m "seed: BRK-P2 (broken test — integer mismatch)"
printf "  BRK-P2             → %s\n" "$(git rev-parse HEAD)"

BROKEN_TESTS_HEAD="$(git rev-parse HEAD)"

# Switch HEAD back to main so the default branch in the bare repo is
# the green baseline, NOT broken-tests.
git checkout -q main

# ── Clone to bare ──────────────────────────────────────────────────
echo ""
echo "Cloning to bare: $GOLDEN_BARE"
git clone --bare -q "$WORK_DIR" "$GOLDEN_BARE"

# ── Verify baseline suite is green in a scratch clone ──────────────
echo ""
echo "Verifying baseline suite..."

SCRATCH_DIR="$(mktemp -d "$VAR_DIR/tmp.scratch.XXXXXX")"
cleanup_scratch() { rm -rf "$SCRATCH_DIR"; }
trap 'cleanup_scratch; cleanup_work' EXIT

git clone -q "$GOLDEN_BARE" "$SCRATCH_DIR"
cd "$SCRATCH_DIR"

# Bootstrap the venv exactly as a raw-arming scenario would — using the
# committed ./bootstrap script.
if ! bash "$SCRATCH_DIR/bootstrap" >/dev/null 2>&1; then
    echo "  ✗ bootstrap failed" >&2
    exit 1
fi

# Baseline (main branch — default) should be GREEN.
if "$SCRATCH_DIR/.venv/bin/python" -m pytest -q >/dev/null 2>&1; then
    echo "  ✓ Baseline test suite: GREEN"
else
    echo "  ✗ Baseline test suite: RED — unexpected!" >&2
    exit 1
fi

# broken-tests branch should be RED (the whole point of BRK seeds).
git checkout -q broken-tests
if "$SCRATCH_DIR/.venv/bin/python" -m pytest -q >/dev/null 2>&1; then
    echo "  ✗ broken-tests branch: GREEN — expected RED!" >&2
    exit 1
else
    echo "  ✓ broken-tests branch: RED (expected)"
fi

# ── Hash report ────────────────────────────────────────────────────
echo ""
echo "══╡ Hashes ╞══════════════════════════════════════════════════════"
printf "%-20s %s\n" "BASELINE" "$BASELINE_HASH"
for seed_id in "${SEED_ORDER[@]}"; do
    h="$(git -C "$GOLDEN_BARE" rev-parse "refs/tags/seed/$seed_id" 2>/dev/null || echo "MISSING")"
    printf "%-20s %s\n" "SEED $seed_id" "$h"
done
printf "%-20s %s\n" "BRANCH broken-tests" "$BROKEN_TESTS_HEAD"

# ── Deterministic verification (on re-run) ─────────────────────────
# Build a stable textual representation of every reference hash.
current_hashes="$(
    printf "BASELINE %s\n" "$BASELINE_HASH"
    for seed_id in "${SEED_ORDER[@]}"; do
        h="$(git -C "$GOLDEN_BARE" rev-parse "refs/tags/seed/$seed_id" 2>/dev/null || echo "MISSING")"
        printf "SEED %s %s\n" "$seed_id" "$h"
    done
    printf "BRANCH broken-tests %s\n" "$BROKEN_TESTS_HEAD"
)"

if [ -f "$HASH_FILE" ]; then
    echo ""
    if [ "$current_hashes" = "$(cat "$HASH_FILE")" ]; then
        echo "══╡ Deterministic build: PASS (hashes match previous run) ╞══"
    else
        echo "══╡ HASH DIVERGENCE — build is not deterministic! ╞══════════"
        echo "--- expected (previous run)"
        cat "$HASH_FILE"
        echo "--- actual (this run)"
        echo "$current_hashes"
        exit 1
    fi
else
    echo ""
    echo "══╡ First build — hashes saved for future verification ╞══════"
fi

printf '%s\n' "$current_hashes" > "$HASH_FILE"

echo ""
echo "Golden bare repo: $GOLDEN_BARE"
