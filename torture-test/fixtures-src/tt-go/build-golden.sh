#!/usr/bin/env bash
# build-golden.sh — deterministic golden bare repo builder for tt-go
#
# Builds torture-test/var/fixtures/golden/tt-go.git from the fixture
# source.  Every commit hash is stable across rebuilds: fixed git author /
# committer identity and timestamps ensure byte-identical repos.
#
# Re-running the script prints hashes and fails if they diverge from the
# previous run — this acts as a self-check for deterministic behaviour.
#
# Usage:
#   bash torture-test/fixtures-src/tt-go/build-golden.sh
#
# Requirements: bash, git, rsync, go (for test verification in the scratch clone).

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
GOLDEN_DIR="${TORTURE_GOLDEN_DIR:-$VAR_DIR/fixtures/golden}"
GOLDEN_BARE="$GOLDEN_DIR/tt-go.git"
HASH_FILE="$GOLDEN_DIR/tt-go.git.hashes"

# ── Create output directories ──────────────────────────────────────
mkdir -p "$GOLDEN_DIR"

# ── Clean up previous golden bare (rebuild is always from scratch) ─
rm -rf "$GOLDEN_BARE"

# ── Prepare work tree ──────────────────────────────────────────────
# Copy fixture source excluding generated crud that shouldn't be committed.
# Use rsync -a to preserve exec bits (testdata/exec-bit-probe.sh).
WORK_DIR="$(mktemp -d "$VAR_DIR/tmp.build-golden.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap cleanup_work EXIT

rsync -a \
    --exclude='build-golden.sh' \
    --exclude='b/' \
    --exclude='operator-notes.local' \
    "$FIXTURE_SRC/" "$WORK_DIR/"

cd "$WORK_DIR"

# ── Seed-order list (defines tag ordering for reproducible iteration) ──
# Order: bugs first (G1→G4), then vulns.
# Broken tests live on their own branch and are not in this list.
readonly SEED_ORDER=(
    BUG-G1
    BUG-G2
    BUG-G3
    BUG-G4
    VULN-G1
    VULN-G2
)

# ── Initialize git repo and create baseline commit ─────────────────
GIT_TEMPLATE_DIR=/dev/null git init -q --initial-branch=main
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git config commit.gpgsign false
git config tag.gpgsign false
git add -A
git commit -q -m "Initial baseline: tt-go fixture (green test suite)"
BASELINE_HASH="$(git rev-parse HEAD)"

# ── apply_one_seed ─────────────────────────────────────────────────
# Usage: apply_one_seed <seed-id>
#
# Checks out the green-baseline commit, copies the seed's overlay file(s)
# into place (stripping //go:build ignore tags), and creates a single
# commit + tag on a detached HEAD.  Skips fix.patch and go.mod files.
# If no overlay files differ from baseline an --allow-empty commit is
# created (needed for dormant vuln seeds whose code already lives in
# baseline).
apply_one_seed() {
    local seed_id="$1"
    local seed_dir="$FIXTURE_SRC/seeds/$seed_id"

    # Start clean from baseline
    git checkout -qf "$BASELINE_HASH" 2>/dev/null
    git clean -fdq

    for f in "$seed_dir"/*; do
        local fname
        fname="$(basename "$f")"
        # Skip fix.patch and go.mod — they are not overlay files
        [ "$fname" = "fix.patch" ] && continue
        [ "$fname" = "go.mod" ] && continue

        local target
        case "$fname" in
            pool.go)           target="pool.go" ;;
            worker.go)         target="worker.go" ;;
            util_command.go)   target="util/command.go" ;;
            util_archive.go)   target="util/archive.go" ;;
            *)
                echo "ERROR: unknown seed overlay file: $fname (seed $seed_id)" >&2
                exit 1
                ;;
        esac

        # Ensure target directory exists (e.g. util/)
        mkdir -p "$(dirname "$target")"

        # Copy overlay, stripping the //go:build ignore tag (and any
        # immediately following blank line) from the seed overlay.
        # This tag is used to keep seed overlays from being compiled when
        # residing in the seeds/ directory, but it must be removed when
        # applying the overlay to the working tree.
        if head -1 "$f" | grep -q '^//go:build ignore$'; then
            tail -n +2 "$f" | sed '1{/^$/d;}' > "$target"
        else
            cp "$f" "$target"
        fi
    done

    # Stage all changes and check if the overlay actually modified anything
    # relative to the baseline tree. If not, the seed is dormant and we
    # create an empty commit so the tag still points to a unique ref.
    git add -A
    if git diff --cached --quiet; then
        git commit -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
    else
        git commit -q -m "seed: $seed_id"
    fi

    git tag "seed/$seed_id"
    printf "  seed/%-12s → %s\n" "$seed_id" "$(git rev-parse HEAD)"
}

# ── Build seed tags ────────────────────────────────────────────────
echo "═╡ build-golden: tt-go fixture ╞══════════════════════════════════"
echo ""
echo "Baseline: $BASELINE_HASH"
echo ""
echo "Seed tags (each on top of baseline):"

for seed_id in "${SEED_ORDER[@]}"; do
    apply_one_seed "$seed_id"
done

# ── broken-tests branch ────────────────────────────────────────────
echo ""
echo "broken-tests branch (BRK-G1 + BRK-G2 on top of baseline):"

git checkout -qf "$BASELINE_HASH" 2>/dev/null
git clean -fdq
git checkout -qb broken-tests

# BRK seeds both modify pool_test.go, so we apply fix patches in reverse
# (patch -R introduces the bug instead of fixing it). This ensures
# both bugs coexist on the broken-tests branch.
# Auto-detect p-level: patches with a/ or b/ prefix need -p1, bare paths need -p0.

_detect_p() {
    local patch_file="$1"
    if grep -m1 '^--- ' "$patch_file" 2>/dev/null | grep -qE '^--- [ab]/'; then
        echo "-p1"
    else
        echo "-p0"
    fi
}

# BRK-G1: off-by-one assertion in TestMultipleResults
patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-G1/fix.patch") -R < "$FIXTURE_SRC/seeds/BRK-G1/fix.patch"
git add -A
git commit -q -m "seed: BRK-G1 (broken test — off-by-one assertion)"
printf "  BRK-G1             → %s\n" "$(git rev-parse HEAD)"

# BRK-G2: inverted boolean assertion in TestSubmitAndCollectResult
patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-G2/fix.patch") -R < "$FIXTURE_SRC/seeds/BRK-G2/fix.patch"
git add -A
git commit -q -m "seed: BRK-G2 (broken test — inverted boolean assertion)"
printf "  BRK-G2             → %s\n" "$(git rev-parse HEAD)"

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

# Baseline (main branch — default) should be GREEN.
if (cd "$SCRATCH_DIR" && go test ./... >/dev/null 2>&1); then
    echo "  ✓ Baseline test suite: GREEN"
else
    echo "  ✗ Baseline test suite: RED — unexpected!" >&2
    exit 1
fi

# broken-tests branch should be RED.
(cd "$SCRATCH_DIR" && git checkout -q broken-tests)
if (cd "$SCRATCH_DIR" && go test ./... >/dev/null 2>&1); then
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
