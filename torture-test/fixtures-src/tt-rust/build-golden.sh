#!/usr/bin/env bash
# build-golden.sh — deterministic golden bare repo builder for tt-rust
#
# Builds torture-test/var/fixtures/golden/tt-rust.git from the fixture
# source.  Every commit hash is stable across rebuilds: fixed git author /
# committer identity and timestamps ensure byte-identical repos.
#
# Re-running the script prints hashes and fails if they diverge from the
# previous run — this acts as a self-check for deterministic behaviour.
#
# Usage:
#   bash torture-test/fixtures-src/tt-rust/build-golden.sh
#
# Requirements: bash, git, rsync, cargo (for test verification in the scratch clone).

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
GOLDEN_BARE="$GOLDEN_DIR/tt-rust.git"
HASH_FILE="$GOLDEN_DIR/tt-rust.git.hashes"

# ── Create output directories ──────────────────────────────────────
mkdir -p "$GOLDEN_DIR"

# ── Clean up previous golden bare (rebuild is always from scratch) ─
rm -rf "$GOLDEN_BARE"

# ── Prepare work tree ──────────────────────────────────────────────
# Copy fixture source excluding generated crud that shouldn't be committed.
WORK_DIR="$(mktemp -d "$VAR_DIR/tmp.build-golden.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap cleanup_work EXIT

rsync -a \
    --exclude='build-golden.sh' \
    --exclude='target/' \
    --exclude='operator-notes.local' \
    "$FIXTURE_SRC/" "$WORK_DIR/"

cd "$WORK_DIR"

# ── Seed-order list (defines tag ordering for reproducible iteration) ──
# Order: bugs first (R1→R4), then vulns.
# Broken tests live on their own branch and are not in this list.
readonly SEED_ORDER=(
    BUG-R1
    BUG-R2
    BUG-R3
    BUG-R4
    VULN-R1
    VULN-R2
)

# ── Initialize git repo and create baseline commit ─────────────────
GIT_TEMPLATE_DIR=/dev/null git init -q --initial-branch=main
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git config commit.gpgsign false
git config tag.gpgsign false
git add -A
git commit -q -m "Initial baseline: tt-rust fixture (green test suite)"
BASELINE_HASH="$(git rev-parse HEAD)"

# ── apply_one_seed ─────────────────────────────────────────────────
# Usage: apply_one_seed <seed-id>
#
# Checks out the green-baseline commit, copies the seed's overlay file(s)
# into place, and creates a single commit + tag on a detached HEAD.
# Skips fix.patch files. If no overlay files differ from baseline an
# --allow-empty commit is created (needed for dormant vuln seeds whose
# code already lives in baseline).
apply_one_seed() {
    local seed_id="$1"
    local seed_dir="$FIXTURE_SRC/seeds/$seed_id"

    # Start clean from baseline
    git checkout -qf "$BASELINE_HASH" 2>/dev/null
    git clean -fdq

    for f in "$seed_dir"/*; do
        local fname
        fname="$(basename "$f")"
        # Skip fix.patch — it is not an overlay file
        [ "$fname" = "fix.patch" ] && continue
        # Skip documentation files
        [ "$fname" = "SEEDS.md" ] && continue

        local target
        case "$fname" in
            bucket.rs)       target="src/bucket.rs" ;;
            config.rs)       target="src/config.rs" ;;
            util_unsafe.rs)  target="src/util_unsafe.rs" ;;
            util_timing.rs)  target="src/util_timing.rs" ;;
            integration.rs)  target="tests/integration.rs" ;;
            *)
                echo "ERROR: unknown seed overlay file: $fname (seed $seed_id)" >&2
                exit 1
                ;;
        esac

        # Ensure target directory exists
        mkdir -p "$(dirname "$target")"
        cp "$f" "$target"
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
echo "═╡ build-golden: tt-rust fixture ╞════════════════════════════════"
echo ""
echo "Baseline: $BASELINE_HASH"
echo ""
echo "Seed tags (each on top of baseline):"

for seed_id in "${SEED_ORDER[@]}"; do
    apply_one_seed "$seed_id"
done

# ── broken-tests branch ────────────────────────────────────────────
echo ""
echo "broken-tests branch (BRK-R1 + BRK-R2 on top of baseline):"

git checkout -qf "$BASELINE_HASH" 2>/dev/null
git clean -fdq
git checkout -qb broken-tests

# BRK seeds both modify tests/integration.rs, so we apply fix patches
# in reverse (patch -R introduces the bug instead of fixing it).
# This ensures both bugs coexist on the broken-tests branch.
# Auto-detect p-level: patches with a/ or b/ prefix need -p1, bare paths need -p0.

_detect_p() {
    local patch_file="$1"
    if grep -m1 '^--- ' "$patch_file" 2>/dev/null | grep -qE '^--- [ab]/'; then
        echo "-p1"
    else
        echo "-p0"
    fi
}

# BRK-R1: off-by-one assertion in integration_concurrent_consumers
patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-R1/fix.patch") -R < "$FIXTURE_SRC/seeds/BRK-R1/fix.patch"
git add -A
git commit -q -m "seed: BRK-R1 (broken test — off-by-one assertion)"
printf "  BRK-R1             → %s\n" "$(git rev-parse HEAD)"

# BRK-R2: inverted boolean assertion in integration_try_consume_fails_when_insufficient
patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-R2/fix.patch") -R < "$FIXTURE_SRC/seeds/BRK-R2/fix.patch"
git add -A
git commit -q -m "seed: BRK-R2 (broken test — inverted boolean assertion)"
printf "  BRK-R2             → %s\n" "$(git rev-parse HEAD)"

BROKEN_TESTS_HEAD="$(git rev-parse HEAD)"

# Switch HEAD back to main so the default branch in the bare repo is
# the green baseline, NOT broken-tests.
git checkout -q main

# ── Verify Cargo.lock is committed in the baseline ─────────────────
if git -C "$WORK_DIR" ls-files --error-unmatch Cargo.lock >/dev/null 2>&1; then
    echo ""
    echo "  ✓ Cargo.lock is tracked in baseline"
else
    echo "  ✗ Cargo.lock is NOT tracked in baseline!" >&2
    exit 1
fi

# ── Clone to bare ──────────────────────────────────────────────────
echo ""
echo "Cloning to bare: $GOLDEN_BARE"
git clone --bare -q "$WORK_DIR" "$GOLDEN_BARE"
# Determinism: `git clone --bare <src>` records the mktemp work dir (
# VAR_DIR/tmp.build-golden.XXXXXX) as the bare's `[remote "origin"] url`.
# That transient path differs every build and would make the golden bare
# NON-byte-identical across rebuilds (US-006 AC3). Remove the origin so the
# bare config is stable; the bare has no need of an upstream remote.
git --git-dir="$GOLDEN_BARE" remote remove origin >/dev/null 2>&1 || true

# ── Verify baseline suite is green in a scratch clone ──────────────
echo ""
echo "Verifying baseline suite..."

SCRATCH_DIR="$(mktemp -d "$VAR_DIR/tmp.scratch.XXXXXX")"
cleanup_scratch() { rm -rf "$SCRATCH_DIR"; }
trap 'cleanup_scratch; cleanup_work' EXIT

git clone -q "$GOLDEN_BARE" "$SCRATCH_DIR"

# Baseline (main branch — default) should be GREEN.
if CARGO_OUT="$(cd "$SCRATCH_DIR" && cargo test --quiet 2>&1)"; then
    echo "  ✓ Baseline test suite: GREEN"
else
    echo "  ✗ Baseline test suite: RED — unexpected!" >&2
    echo "  ── last lines of cargo test output ──" >&2
    printf '%s\n' "$CARGO_OUT" | tail -20 >&2
    exit 1
fi

# ── Junk probe verification (baseline scratch clone) ───────────────
echo ""
echo "Verifying junk probes in scratch clone..."

# target/ must exist after cargo test and be untracked
if [ -d "$SCRATCH_DIR/target" ]; then
    echo "  ✓ target/ exists after cargo test"
else
    echo "  ✗ target/ is missing after cargo test!" >&2
    exit 1
fi

# target/ must NOT be tracked by git
if TRACKED_OUT="$(git -C "$SCRATCH_DIR" ls-files --error-unmatch target/ 2>&1)"; then
    echo "  ✗ target/ is tracked — should be untracked!" >&2
    echo "  ── git ls-files output ──" >&2
    printf '%s\n' "$TRACKED_OUT" | tail -20 >&2
    exit 1
else
    echo "  ✓ target/ is untracked"
fi

# .gitignore must NOT contain target/
if grep -q '^target/' "$SCRATCH_DIR/.gitignore" 2>/dev/null; then
    echo "  ✗ .gitignore contains target/ — should NOT!" >&2
    exit 1
else
    echo "  ✓ .gitignore does NOT contain target/"
fi

# operator-notes.local must NOT be in the golden repo (excluded junk)
if [ -f "$SCRATCH_DIR/operator-notes.local" ]; then
    echo "  ✗ operator-notes.local is present — should be excluded junk!" >&2
    exit 1
else
    echo "  ✓ operator-notes.local is absent (excluded junk)"
fi

# ── broken-tests branch should be RED ──────────────────────────────
echo ""
echo "Verifying broken-tests branch..."

(cd "$SCRATCH_DIR" && git checkout -q broken-tests)
if CARGO_OUT="$(cd "$SCRATCH_DIR" && cargo test --quiet 2>&1)"; then
    echo "  ✗ broken-tests branch: GREEN — expected RED!" >&2
    echo "  ── last lines of cargo test output ──" >&2
    printf '%s\n' "$CARGO_OUT" | tail -20 >&2
    exit 1
else
    echo "  ✓ broken-tests branch: RED (expected)"
fi

# ── Seed verification: fix patches must restore green ────────────
echo ""
echo "Verifying seed refs and fix patches..."

for seed_id in "${SEED_ORDER[@]}"; do
    # Checkout the seed ref and clean any artifacts from previous runs
    (cd "$SCRATCH_DIR" && git checkout -q "seed/$seed_id" && git clean -fdq)

    # Run tests with timeout (BUG-R3 hangs by design — A3 infinite loop)
    if timeout 15 cargo test --quiet >/dev/null 2>&1; then
        echo "  • seed/$seed_id: tests GREEN (bugs are dormant on this test suite)"
    else
        echo "  • seed/$seed_id: tests RED or TIMEOUT (expected symptom — this is a seeded defect)"
    fi

    # Clean up any stale cargo processes left by hanging tests (e.g. BUG-R3)
    pkill -f "cargo test.*ttrust" 2>/dev/null || true
    sleep 1

    # Restore clean working tree on top of the seed ref
    (cd "$SCRATCH_DIR" && git checkout -q -- . && git clean -fdq)

    # Apply fix.patch and verify GREEN (the fix must restore green always)
    seed_fix="$FIXTURE_SRC/seeds/$seed_id/fix.patch"
    if [ -f "$seed_fix" ]; then
        if patch -s $(_detect_p "$seed_fix") -d "$SCRATCH_DIR" < "$seed_fix"; then
            if CARGO_OUT="$(cd "$SCRATCH_DIR" && cargo test --quiet 2>&1)"; then
                echo "  ✓ seed/$seed_id + fix.patch: GREEN"
            else
                echo "  ✗ seed/$seed_id + fix.patch: RED!" >&2
                echo "  ── last lines of cargo test output ──" >&2
                printf '%s\n' "$CARGO_OUT" | tail -20 >&2
                exit 1
            fi
            # Restore to clean seed state for next iteration
            (cd "$SCRATCH_DIR" && git checkout -q -- .)
        else
            echo "  ✗ seed/$seed_id: fix.patch failed to apply!" >&2
            exit 1
        fi
    fi
done

# ── Apply fix patches on broken-tests to verify restoration ────────
echo ""
echo "Verifying broken-tests fix patches restore green..."

(cd "$SCRATCH_DIR" && git checkout -q broken-tests)

# Apply BRK-R1 fix.patch (normally, not reversed)
if patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-R1/fix.patch") -d "$SCRATCH_DIR" < "$FIXTURE_SRC/seeds/BRK-R1/fix.patch"; then
    # Apply BRK-R2 fix.patch on top
    if patch -s $(_detect_p "$FIXTURE_SRC/seeds/BRK-R2/fix.patch") -d "$SCRATCH_DIR" < "$FIXTURE_SRC/seeds/BRK-R2/fix.patch"; then
        # Both fix patches applied — should be fully green now
        if CARGO_OUT="$(cd "$SCRATCH_DIR" && cargo test --quiet 2>&1)"; then
            echo "  ✓ broken-tests + all fix patches: GREEN"
        else
            echo "  ✗ broken-tests + all fix patches: RED!" >&2
            echo "  ── last lines of cargo test output ──" >&2
            printf '%s\n' "$CARGO_OUT" | tail -20 >&2
            exit 1
        fi
    else
        echo "  ✗ BRK-R2 fix.patch failed to apply on broken-tests!" >&2
        exit 1
    fi
else
    echo "  ✗ BRK-R1 fix.patch failed to apply on broken-tests!" >&2
    exit 1
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
