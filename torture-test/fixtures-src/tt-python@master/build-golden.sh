#!/usr/bin/env bash
# build-golden.sh — master-branch variant of the tt-python golden builder
#
# This variant produces a bare repo whose default branch is **master**
# (not main).  All content is identical to the main tt-python fixture,
# but the default branch rename is used by W2.22 to detect hardcoded
# "main" references in bundled prompts.
#
# The script reuses the SAME source as tt-python (../tt-python/) and
# only changes the git init branch name and output path.
#
# Usage:
#   bash torture-test/fixtures-src/tt-python@master/build-golden.sh
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
# Reuse the same source as tt-python — only the branch name differs
FIXTURE_SRC="$(cd "$SCRIPT_DIR/../tt-python" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VAR_DIR="$REPO_ROOT/torture-test/var"
GOLDEN_DIR="${TORTURE_GOLDEN_DIR:-$VAR_DIR/fixtures/golden}"
GOLDEN_BARE="$GOLDEN_DIR/tt-python@master.git"
HASH_FILE="$GOLDEN_DIR/.build-hashes-tt-python-master"

# ── Create output directories ──────────────────────────────────────
mkdir -p "$GOLDEN_DIR"

# ── Clean up previous golden bare (rebuild is always from scratch) ─
rm -rf "$GOLDEN_BARE"

# ── Prepare work tree ──────────────────────────────────────────────
WORK_DIR="$(mktemp -d "$VAR_DIR/tmp.build-golden-master.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap cleanup_work EXIT

rsync -a \
    --exclude='.venv/' \
    --exclude='.mypy_cache/' \
    --exclude='__pycache__/' \
    --exclude='*.egg-info/' \
    --exclude='.pytest_cache/' \
    --exclude='.flaky_counter' \
    --exclude='operator-notes.local' \
    --exclude='build-golden.sh' \
    "$FIXTURE_SRC/" "$WORK_DIR/"

cd "$WORK_DIR"

# ── Seed-order list (identical to main variant) ────────────────────
readonly SEED_ORDER=(
    BUG-P1
    BUG-P2
    BUG-P3
    BUG-P4
    VULN-P1
    VULN-P2
    FLAKY-P1
)

# ── Initialize git repo with master as default branch ──────────────
# This is the ONLY change from the main variant:
# --initial-branch=master instead of --initial-branch=main.
git init -q --initial-branch=master
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git config commit.gpgsign false
git config tag.gpgsign false
git add -A
git commit -q -m "Initial baseline: tt-python fixture (green test suite, master variant)"
BASELINE_HASH="$(git rev-parse HEAD)"

# ── apply_one_seed ─────────────────────────────────────────────────
apply_one_seed() {
    local seed_id="$1"
    local seed_dir="$FIXTURE_SRC/seeds/$seed_id"

    git checkout -qf "$BASELINE_HASH" 2>/dev/null
    git clean -fdq

    local changed=false
    for f in "$seed_dir"/*; do
        local fname
        fname="$(basename "$f")"
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
echo "═╡ build-golden: tt-python@master fixture ╞═══════════════════════"
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

# Switch HEAD back to master so the default branch in the bare repo is
# the green baseline, NOT broken-tests.
git checkout -q master

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

# ── Verify default branch is master (not main) ─────────────────────
echo ""
echo "Verifying default branch is master..."
DEFAULT_BRANCH="$(git -C "$GOLDEN_BARE" symbolic-ref HEAD 2>/dev/null || echo "?")"
if [ "$DEFAULT_BRANCH" != "refs/heads/master" ]; then
    echo "  ✗ Default branch is '$DEFAULT_BRANCH' — expected 'refs/heads/master'" >&2
    exit 1
fi
echo "  ✓ Default branch: master"

# ── Verify NO main ref exists anywhere ─────────────────────────────
echo ""
echo "Verifying no 'main' ref exists..."
if git -C "$GOLDEN_BARE" show-ref --verify --quiet refs/heads/main 2>/dev/null; then
    echo "  ✗ refs/heads/main exists — should not!" >&2
    exit 1
fi
if git -C "$GOLDEN_BARE" rev-parse --verify main 2>/dev/null; then
    echo "  ✗ 'main' resolves to a ref — should be absent!" >&2
    exit 1
fi
echo "  ✓ No 'main' ref present"

# ── Verify all seed tags exist ─────────────────────────────────────
echo ""
echo "Verifying all seed tags..."

MISSING_SEEDS=()
for seed_id in "${SEED_ORDER[@]}"; do
    if ! git -C "$GOLDEN_BARE" rev-parse --verify "refs/tags/seed/$seed_id" >/dev/null 2>&1; then
        MISSING_SEEDS+=("$seed_id")
    fi
done
if ! git -C "$GOLDEN_BARE" rev-parse --verify refs/heads/broken-tests >/dev/null 2>&1; then
    MISSING_SEEDS+=("broken-tests branch")
fi

if [ ${#MISSING_SEEDS[@]} -gt 0 ]; then
    echo "  ✗ Missing: ${MISSING_SEEDS[*]}" >&2
    exit 1
fi
echo "  ✓ All ${#SEED_ORDER[@]} seeds + broken-tests branch present"

# ── Verify baseline suite is green in a scratch clone ──────────────
echo ""
echo "Verifying baseline suite..."

SCRATCH_DIR="$(mktemp -d "$VAR_DIR/tmp.scratch-master.XXXXXX")"
cleanup_scratch() { rm -rf "$SCRATCH_DIR"; }
trap 'cleanup_scratch; cleanup_work' EXIT

git clone -q "$GOLDEN_BARE" "$SCRATCH_DIR"
cd "$SCRATCH_DIR"

# Verify the clone's default branch is master
CLONE_BRANCH="$(git -C "$SCRATCH_DIR" symbolic-ref HEAD 2>/dev/null || echo "?")"
if [ "$CLONE_BRANCH" != "refs/heads/master" ]; then
    echo "  ✗ Clone default branch is '$CLONE_BRANCH' — expected 'refs/heads/master'" >&2
    exit 1
fi
echo "  ✓ Clone default branch: master"

if ! bash "$SCRATCH_DIR/bootstrap" >/dev/null 2>&1; then
    echo "  ✗ bootstrap failed" >&2
    exit 1
fi

# Baseline (master branch — default) should be GREEN.
if "$SCRATCH_DIR/.venv/bin/python" -m pytest -q >/dev/null 2>&1; then
    echo "  ✓ Baseline test suite: GREEN"
else
    echo "  ✗ Baseline test suite: RED — unexpected!" >&2
    exit 1
fi

# broken-tests branch should be RED.
git checkout -q broken-tests
if "$SCRATCH_DIR/.venv/bin/python" -m pytest -q >/dev/null 2>&1; then
    echo "  ✗ broken-tests branch: GREEN — expected RED!" >&2
    exit 1
else
    echo "  ✓ broken-tests branch: RED (expected)"
fi

# ── Verify junk-probe invariants ───────────────────────────────────
echo ""
echo "Verifying junk-probe invariants..."

# Re-checkout master for a clean state
git -C "$SCRATCH_DIR" checkout -q master
"$SCRATCH_DIR/.venv/bin/python" -m pytest -q >/dev/null 2>&1

cd "$SCRATCH_DIR"
JUNK_OK=true

# __pycache__ must exist and be untracked (not gitignored)
if [ ! -d "__pycache__" ]; then
    echo "  ✗ __pycache__/ not found after test run" >&2
    JUNK_OK=false
elif ! git ls-files --error-unmatch __pycache__/c &>/dev/null; then
    # It must be untracked — ls-files returns non-zero for untracked files
    echo "  ✓ __pycache__/ present and untracked"
else
    echo "  ✗ __pycache__/ is tracked — should be untracked" >&2
    JUNK_OK=false
fi

# .pytest_cache must exist and be untracked
if [ ! -d ".pytest_cache" ]; then
    echo "  ✗ .pytest_cache/ not found after test run" >&2
    JUNK_OK=false
elif ! git ls-files --error-unmatch .pytest_cache/c &>/dev/null; then
    echo "  ✓ .pytest_cache/ present and untracked"
else
    echo "  ✗ .pytest_cache/ is tracked — should be untracked" >&2
    JUNK_OK=false
fi

# operator-notes.local must NOT be in the golden tree — it is inert junk
# planted at provisioning (spec 02: one per repo, planted at instantiation,
# must stay untracked). The clone derives from the golden bare, so it too must
# lack it.
ORIG_NOTES="$FIXTURE_SRC/operator-notes.local"
if [ -e "$SCRATCH_DIR/operator-notes.local" ]; then
    echo "  ✗ operator-notes.local is present in golden clone — should be excluded junk" >&2
    JUNK_OK=false
else
    echo "  ✓ operator-notes.local absent from golden (excluded junk)"
fi

# The fixture SOURCE operator-notes.local is the byte-exact provisioning
# reference (spec 02: planted at instantiation, byte-identical). The canonical
# bytes must be retained so provisioning can plant them into work clones.
if [ ! -s "$ORIG_NOTES" ]; then
    echo "  ✗ operator-notes.local fixture source missing/empty — provisioning reference lost" >&2
    JUNK_OK=false
else
    echo "  ✓ operator-notes.local fixture source retained (byte-exact provisioning ref)"
fi

if ! $JUNK_OK; then
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
