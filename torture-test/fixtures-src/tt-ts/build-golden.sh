#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# build-golden.sh — Deterministic golden builder for tt-ts fixture
# =============================================================================
# Builds a byte-stable bare repository at torture-test/var/fixtures/golden/tt-ts.git
# with immutable seed refs and verifies all invariants after build.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
FIXTURE_SRC="$SCRIPT_DIR"
GOLDEN_DIR="${TORTURE_GOLDEN_DIR:-$REPO_ROOT/torture-test/var/fixtures/golden}"
BARE_REPO="$GOLDEN_DIR/tt-ts.git"
HASH_FILE="$GOLDEN_DIR/tt-ts.git.hashes"

# -------------------------------------------------------------------
# Deterministic commit environment (byte-stable hashes across rebuilds)
# -------------------------------------------------------------------
export GIT_AUTHOR_NAME='Torture Test'
export GIT_AUTHOR_EMAIL='torture@test.local'
export GIT_AUTHOR_DATE='2025-01-15T10:00:00 +0000'
export GIT_COMMITTER_NAME='Torture Test'
export GIT_COMMITTER_EMAIL='torture@test.local'
export GIT_COMMITTER_DATE='2025-01-15T10:00:00 +0000'

# -------------------------------------------------------------------
# Cleanup trap — remove all scratch directories on exit
# -------------------------------------------------------------------
SCRATCH_DIRS=()
cleanup() {
    for d in "${SCRATCH_DIRS[@]}"; do
        if [ -n "$d" ] && [ -d "$d" ]; then
            rm -rf "$d"
        fi
    done
    if [ -n "${SCRATCH_BASE:-}" ] && [ -d "$SCRATCH_BASE" ]; then
        rm -rf "$SCRATCH_BASE"
    fi
}
trap cleanup EXIT

scratch_dir() {
    local __resultvar=$1
    if [ -z "${SCRATCH_BASE:-}" ]; then
        SCRATCH_BASE="$(mktemp -d "$GOLDEN_DIR/.scratch.XXXXXX")"
    fi
    local d
    d="$(mktemp -d "$SCRATCH_BASE/work.XXXXXX")"
    SCRATCH_DIRS+=("$d")
    eval "$__resultvar='$d'"
}

# -------------------------------------------------------------------
# Banner
# -------------------------------------------------------------------
echo "================================================================="
echo " build-golden.sh — tt-ts deterministic golden builder"
echo "================================================================="
echo "  Fixture source : $FIXTURE_SRC"
echo "  Golden dir     : $GOLDEN_DIR"
echo "  Bare repo      : $BARE_REPO"
echo ""

# -------------------------------------------------------------------
# Phase 1 — Build the bare repository
# -------------------------------------------------------------------
echo "--- Phase 1: Building bare repository ---"

rm -rf "$BARE_REPO"
mkdir -p "$GOLDEN_DIR"

scratch_dir WORK_DIR

# Initialize a fresh git repo and copy fixture source files
# Excluding: node_modules/, dist/, package-lock.json, and this script itself
# Disable template copying (GIT_TEMPLATE_DIR=/dev/null) to avoid copying
# system git templates into scratch directories.
(
    cd "$WORK_DIR"
    GIT_TEMPLATE_DIR=/dev/null git init --initial-branch=main > /dev/null

    # Copy fixture source via tar, excluding build artifacts and junk
    (
        cd "$FIXTURE_SRC"
        tar --exclude='node_modules' \
            --exclude='dist' \
            --exclude='package-lock.json' \
            --exclude='build-golden.sh' \
            -cf - .
    ) | tar -xf -

    git add -A
    git commit --no-gpg-sign -m "Initial baseline: expense tracker" > /dev/null
)

BASELINE_SHA="$(cd "$WORK_DIR" && git rev-parse HEAD)"
echo "  Baseline commit : $BASELINE_SHA"

# Create bare repo and push baseline
GIT_TEMPLATE_DIR=/dev/null git init --bare "$BARE_REPO" > /dev/null
(
    cd "$WORK_DIR"
    git push "$BARE_REPO" HEAD:refs/heads/main > /dev/null 2>&1
)
# Set HEAD so clones default to main
git --git-dir="$BARE_REPO" symbolic-ref HEAD refs/heads/main
echo "  Pushed main to bare repo"

# -------------------------------------------------------------------
# Phase 2 — Build seed refs from patches
# -------------------------------------------------------------------
echo ""
echo "--- Phase 2: Building seed refs ---"

# Seeds created from patches (BUG-T1..T4, BRK-T1..T2)
PATCHED_SEEDS=("BUG-T1" "BUG-T2" "BUG-T3" "BUG-T4" "BRK-T1" "BRK-T2")
declare -A SEED_SHAS

for seed_id in "${PATCHED_SEEDS[@]}"; do
    seed_patch="seeds/${seed_id}.patch"
    echo "  seed/$seed_id..."

    scratch_dir SEED_WORK

    git clone "$BARE_REPO" "$SEED_WORK" > /dev/null 2>&1
    (
        cd "$SEED_WORK"
        git checkout "$BASELINE_SHA" > /dev/null 2>&1
        git apply -p4 "$FIXTURE_SRC/$seed_patch"
        git add -A
        git commit --no-gpg-sign -m "seed: $seed_id" > /dev/null
    )

    SEED_SHA="$(cd "$SEED_WORK" && git rev-parse HEAD)"
    SEED_SHAS["$seed_id"]="$SEED_SHA"

    (
        cd "$SEED_WORK"
        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    echo "    -> $SEED_SHA"
done

# Vulns are dormant in the green baseline — seed refs point directly to baseline
echo "  seed/VULN-T1 (dormant -> baseline)..."
git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/VULN-T1" "$BASELINE_SHA"
SEED_SHAS["VULN-T1"]="$BASELINE_SHA"
echo "    -> $BASELINE_SHA"

echo "  seed/VULN-T2 (dormant -> baseline)..."
git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/VULN-T2" "$BASELINE_SHA"
SEED_SHAS["VULN-T2"]="$BASELINE_SHA"
echo "    -> $BASELINE_SHA"

ALL_SEEDS=("BUG-T1" "BUG-T2" "BUG-T3" "BUG-T4" "BRK-T1" "BRK-T2" "VULN-T1" "VULN-T2")

# -------------------------------------------------------------------
# Phase 3 — Post-build verification
# -------------------------------------------------------------------
echo ""
echo "--- Phase 3: Post-build verification ---"

scratch_dir VERIFY_DIR
git clone "$BARE_REPO" "$VERIFY_DIR" > /dev/null 2>&1

# Operator notes reference content (from committed file)
OPERATOR_REF="$(cat "$FIXTURE_SRC/operator-notes.local")"

# --- 3a. Baseline green check -------------------------------------------------
echo ""
echo "  [3a] Baseline green check..."
(
    cd "$VERIFY_DIR"
    npm install > /dev/null 2>&1
    if npm test > /dev/null 2>&1; then
        echo "    main: GREEN"
    else
        echo "    main: FAILED — baseline suite is not green!"
        exit 1
    fi
)

# --- 3b. Junk probe verification (baseline clone) -----------------------------
echo ""
echo "  [3b] Junk probe verification..."

# package-lock.json must exist and be untracked
if [ -f "$VERIFY_DIR/package-lock.json" ]; then
    if (cd "$VERIFY_DIR" && git status --porcelain package-lock.json | grep -q '^??'); then
        echo "    package-lock.json : UNTRACKED (ok)"
    else
        echo "    package-lock.json : TRACKED or MISSING — junk probe failure!"
        (cd "$VERIFY_DIR" && git status --porcelain package-lock.json)
        exit 1
    fi
else
    echo "    package-lock.json : MISSING after npm install!"
    exit 1
fi

# node_modules/ must exist and be untracked
if [ -d "$VERIFY_DIR/node_modules" ]; then
    if (cd "$VERIFY_DIR" && git status --porcelain node_modules/ | head -1 | grep -q '^??'); then
        echo "    node_modules/     : UNTRACKED (ok)"
    else
        echo "    node_modules/     : TRACKED or MISSING — junk probe failure!"
        (cd "$VERIFY_DIR" && git status --porcelain node_modules/ | head -3)
        exit 1
    fi
else
    echo "    node_modules/     : MISSING after npm install!"
    exit 1
fi

# .gitignore must NOT list package-lock.json or node_modules/ as ignored patterns
# (ignore comments — only check actual gitignore patterns, not lines starting with #)
if grep -v '^#' "$VERIFY_DIR/.gitignore" | grep -q 'package-lock.json'; then
    echo "    .gitignore        : FAIL — package-lock.json is gitignored (must NOT be)!"
    exit 1
fi
if grep -v '^#' "$VERIFY_DIR/.gitignore" | grep -q '^node_modules'; then
    echo "    .gitignore        : FAIL — node_modules/ is gitignored (must NOT be)!"
    exit 1
fi
echo "    .gitignore        : OK (does not ignore junk probes)"

# operator-notes.local byte-identical check
ACTUAL_OP="$(cat "$VERIFY_DIR/operator-notes.local")"
if [ "$ACTUAL_OP" = "$OPERATOR_REF" ]; then
    echo "    operator-notes.local : byte-identical (ok)"
else
    echo "    operator-notes.local : BYTE-MISMATCH!"
    exit 1
fi

# --- 3c. Seed ref verification (BUG + BRK) ------------------------------------
echo ""
echo "  [3c] Seed ref verification..."

declare -A BUG_SYMPTOMS
BUG_SYMPTOMS["BUG-T1"]="off-by-one"
BUG_SYMPTOMS["BUG-T2"]="date-filter|date-range|getByDateRange"
BUG_SYMPTOMS["BUG-T3"]="order|ordering|position"
BUG_SYMPTOMS["BUG-T4"]="performance|threshold|under 50ms"
BUG_SYMPTOMS["BRK-T1"]="getTotal|sum|150"
BUG_SYMPTOMS["BRK-T2"]="201|200|status.*expected"

for seed_id in "${PATCHED_SEEDS[@]}"; do
    echo "    seed/$seed_id..."

    scratch_dir SEED_VERIFY
    git clone "$BARE_REPO" "$SEED_VERIFY" > /dev/null 2>&1

    # Checkout seed ref and install deps
    (
        cd "$SEED_VERIFY"
        git checkout "seed/$seed_id" > /dev/null 2>&1
        npm install > /dev/null 2>&1
    )

    # Run tests — capture output and exit code
    set +e
    TEST_OUTPUT="$(cd "$SEED_VERIFY" && npm test 2>&1)"
    TEST_EXIT=$?
    set -e

    if [ "${seed_id:0:3}" = "BRK" ]; then
        # BRK seeds must be RED
        if [ "$TEST_EXIT" -ne 0 ]; then
            echo "      RED ($TEST_EXIT failures — ok)"
        else
            echo "      UNEXPECTED GREEN — BRK seed should fail!"
            exit 1
        fi
    else
        # BUG seeds are dormant (GREEN baseline)
        if [ "$TEST_EXIT" -eq 0 ]; then
            echo "      GREEN (dormant — ok)"
        else
            echo "      UNEXPECTED RED — BUG seed should be dormant!"
            echo "      Test output:"
            echo "$TEST_OUTPUT" | tail -20
            exit 1
        fi
    fi

    # Apply fix patch on top of seed — must be GREEN
    fix_patch="$FIXTURE_SRC/seeds/fix/${seed_id}-fix.patch"
    (
        cd "$SEED_VERIFY"
        git apply -p4 "$fix_patch" || {
            echo "      Fix patch FAILED to apply!"
            exit 1
        }
        if npm test > /dev/null 2>&1; then
            echo "      +fix: GREEN"
        else
            echo "      +fix: FAILED — fix did not restore green!"
            exit 1
        fi
    )
done

# --- 3d. VULN fix verification ------------------------------------------------
echo ""
echo "  [3d] VULN fix verification (applied directly to baseline)..."

VULN_SEEDS=("VULN-T1" "VULN-T2")
for vuln_id in "${VULN_SEEDS[@]}"; do
    echo "    $vuln_id..."

    scratch_dir VULN_VERIFY
    git clone "$BARE_REPO" "$VULN_VERIFY" > /dev/null 2>&1
    (
        cd "$VULN_VERIFY"
        npm install > /dev/null 2>&1
        git apply -p4 "$FIXTURE_SRC/seeds/fix/${vuln_id}-fix.patch" || {
            echo "      Fix patch FAILED to apply!"
            exit 1
        }
        if npm test > /dev/null 2>&1; then
            echo "      +fix: GREEN"
        else
            echo "      +fix: FAILED — VULN fix broke the suite!"
            exit 1
        fi
    )
done

# -------------------------------------------------------------------
# Phase 4 — Hash stability
# -------------------------------------------------------------------
echo ""
echo "--- Phase 4: Hash stability ---"

# Collect current hashes
NEW_HASHES="$(mktemp "$GOLDEN_DIR/.hashes.XXXXXX")"
{
    echo "baseline=$BASELINE_SHA"
    for seed_id in "${ALL_SEEDS[@]}"; do
        ref_sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id")"
        echo "seed/$seed_id=$ref_sha"
    done
} > "$NEW_HASHES"

echo "  Current hashes:"
cat "$NEW_HASHES" | while IFS='=' read -r key val; do
    printf "    %-22s %s\n" "$key" "$val"
done

# Compare against previous run (if stored)
if [ -f "$HASH_FILE" ]; then
    if diff "$NEW_HASHES" "$HASH_FILE" > /dev/null 2>&1; then
        echo ""
        echo "  Hash stability: IDENTICAL — matches previous run"
    else
        echo ""
        echo "  Hash stability: MISMATCH!"
        echo "  Expected (previous run):"
        cat "$HASH_FILE"
        echo "  Got:"
        cat "$NEW_HASHES"
        rm -f "$NEW_HASHES"
        exit 1
    fi
else
    echo ""
    echo "  Hash stability: FIRST RUN — no previous hashes to compare"
fi

# Save hashes for next run
cp "$NEW_HASHES" "$HASH_FILE"
rm -f "$NEW_HASHES"
echo "  Hashes saved to $HASH_FILE"

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "================================================================="
echo " build-golden.sh — COMPLETE"
echo "================================================================="
echo "  Bare repo      : $BARE_REPO"
echo "  Baseline       : $BASELINE_SHA"
for seed_id in "${ALL_SEEDS[@]}"; do
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id")"
    printf "  %-16s: %s\n" "seed/$seed_id" "$sha"
done
echo ""
echo "  Verification   : ALL PASSED"
echo "    - Baseline green"
echo "    - Junk probes verified (untracked, not gitignored)"
echo "    - operator-notes.local byte-identical"
echo "    - Seed refs verified (BRK: RED, BUG: dormant GREEN)"
echo "    - Fix patches applied and green"
echo "================================================================="
