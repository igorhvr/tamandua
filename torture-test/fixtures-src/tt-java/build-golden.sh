#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# build-golden.sh — Deterministic golden builder for tt-java fixture
# =============================================================================
# Builds a byte-stable bare repository at
#   torture-test/var/fixtures/golden/tt-java.git
# with immutable seed refs and verifies all invariants after build.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
FIXTURE_SRC="$SCRIPT_DIR"
GOLDEN_DIR="${TORTURE_GOLDEN_DIR:-$REPO_ROOT/torture-test/var/fixtures/golden}"
BARE_REPO="$GOLDEN_DIR/tt-java.git"
HASH_FILE="$GOLDEN_DIR/tt-java.git.hashes"

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
# JAVA_HOME / JDK discovery for Maven execution
# -------------------------------------------------------------------
# Honour JAVA_HOME if already set; otherwise mvnw auto-discovers it.
# We export it so child processes (mvnw) can find the JDK.
if [ -n "${JAVA_HOME:-}" ]; then
    export JAVA_HOME
else
    # mvnw uses its own discovery — leave unset and let it find java on PATH
    :
fi

# Maven local repo cache under var/ to avoid polluting ~/.m2
MAVEN_REPO_LOCAL="$REPO_ROOT/torture-test/var/m2-repository"
mkdir -p "$MAVEN_REPO_LOCAL"
MVN_OPTS="-Dmaven.repo.local=$MAVEN_REPO_LOCAL"

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
echo " build-golden.sh — tt-java deterministic golden builder"
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
# Excluding: target/ (regenerated junk probe), and this script itself
# Disable template copying (GIT_TEMPLATE_DIR=/dev/null) to avoid copying
# system git templates into scratch directories.
(
    cd "$WORK_DIR"
    GIT_TEMPLATE_DIR=/dev/null git init --initial-branch=main > /dev/null

    # Copy fixture source via tar, excluding build artifacts and junk
    (
        cd "$FIXTURE_SRC"
        tar --exclude='target' \
            --exclude='build-golden.sh' \
            --exclude='operator-notes.local' \
            -cf - .
    ) | tar -xf -

    git add -A
    git commit --no-gpg-sign -m "Initial baseline: tt-java fixture (CSV ledger parser)" > /dev/null
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

# Seeds created from patches (BUG-J1..J4, BRK-J1..J2)
PATCHED_SEEDS=("BUG-J1" "BUG-J2" "BUG-J3" "BUG-J4" "BRK-J1" "BRK-J2")
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
echo "  seed/VULN-J1 (dormant -> baseline)..."
git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/VULN-J1" "$BASELINE_SHA"
SEED_SHAS["VULN-J1"]="$BASELINE_SHA"
echo "    -> $BASELINE_SHA"

echo "  seed/VULN-J2 (dormant -> baseline)..."
git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/VULN-J2" "$BASELINE_SHA"
SEED_SHAS["VULN-J2"]="$BASELINE_SHA"
echo "    -> $BASELINE_SHA"

ALL_SEEDS=("BUG-J1" "BUG-J2" "BUG-J3" "BUG-J4" "BRK-J1" "BRK-J2" "VULN-J1" "VULN-J2")

# -------------------------------------------------------------------
# Phase 3 — Post-build verification
# -------------------------------------------------------------------
echo ""
echo "--- Phase 3: Post-build verification ---"

scratch_dir VERIFY_DIR
git clone "$BARE_REPO" "$VERIFY_DIR" > /dev/null 2>&1

# --- 3a. Baseline green check -------------------------------------------------
echo ""
echo "  [3a] Baseline green check..."
(
    cd "$VERIFY_DIR"
    if ./mvnw -q -B $MVN_OPTS test > /dev/null 2>&1; then
        echo "    main: GREEN"
    else
        echo "    main: FAILED — baseline suite is not green!"
        exit 1
    fi
)

# --- 3b. Junk probe verification (baseline clone) -----------------------------
echo ""
echo "  [3b] Junk probe verification..."

# target/ must exist after test run (regenerated junk)
if [ -d "$VERIFY_DIR/target" ]; then
    if (cd "$VERIFY_DIR" && git status --porcelain target/ | head -1 | grep -q '^??'); then
        echo "    target/           : UNTRACKED (ok)"
    else
        echo "    target/           : TRACKED — junk probe failure!"
        (cd "$VERIFY_DIR" && git status --porcelain target/ | head -3)
        exit 1
    fi
else
    echo "    target/           : MISSING after test run!"
    exit 1
fi

# .gitignore must NOT list target/ as an ignored pattern
# (ignore comments — only check actual gitignore patterns)
if grep -v '^#' "$VERIFY_DIR/.gitignore" | grep -q '^target'; then
    echo "    .gitignore        : FAIL — target/ is gitignored (must NOT be)!"
    exit 1
fi
echo "    .gitignore        : OK (does not ignore target/)"

# operator-notes.local must NOT be in the golden tree — it is inert junk
# planted at provisioning (spec 02), never committed. The clone (VERIFY_DIR)
# derives from the golden bare, so it too must lack it.
if [ -e "$VERIFY_DIR/operator-notes.local" ]; then
    echo "    operator-notes.local : PRESENT in golden — should be excluded junk!"
    exit 1
else
    echo "    operator-notes.local : absent from golden (excluded junk, ok)"
fi

# The fixture SOURCE operator-notes.local is the byte-exact provisioning
# reference (spec 02: planted at instantiation, byte-identical). It is NOT
# committed, but the canonical bytes must be retained here so provisioning can
# plant them into every work clone.
if [ ! -s "$FIXTURE_SRC/operator-notes.local" ]; then
    echo "    operator-notes.local : fixture source missing/empty — provisioning reference lost!"
    exit 1
else
    echo "    operator-notes.local : fixture source retained (byte-exact provisioning ref)"
fi

# --- 3c. Seed ref verification (BUG + BRK) ------------------------------------
echo ""
echo "  [3c] Seed ref verification..."

for seed_id in "${PATCHED_SEEDS[@]}"; do
    echo "    seed/$seed_id..."

    scratch_dir SEED_VERIFY
    git clone "$BARE_REPO" "$SEED_VERIFY" > /dev/null 2>&1

    # Checkout seed ref
    (
        cd "$SEED_VERIFY"
        git checkout "seed/$seed_id" > /dev/null 2>&1
    )

    # Run tests — capture output and exit code
    set +e
    TEST_OUTPUT="$(cd "$SEED_VERIFY" && ./mvnw -q -B $MVN_OPTS test 2>&1)"
    TEST_EXIT=$?
    set -e

    if [ "${seed_id:0:3}" = "BRK" ]; then
        # BRK seeds must be RED
        if [ "$TEST_EXIT" -ne 0 ]; then
            echo "      RED (failures — ok)"
        else
            echo "      UNEXPECTED GREEN — BRK seed should fail!"
            exit 1
        fi
    else
        # BUG seeds — BUG-J1..J3 are active (RED), BUG-J4 is dormant (GREEN on existing tests)
        if [ "$TEST_EXIT" -eq 0 ]; then
            echo "      GREEN (dormant — ok)"
        else
            echo "      RED (active bug — ok)"
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
        if ./mvnw -q -B $MVN_OPTS test > /dev/null 2>&1; then
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

VULN_SEEDS=("VULN-J1" "VULN-J2")
for vuln_id in "${VULN_SEEDS[@]}"; do
    echo "    $vuln_id..."

    scratch_dir VULN_VERIFY
    git clone "$BARE_REPO" "$VULN_VERIFY" > /dev/null 2>&1
    (
        cd "$VULN_VERIFY"
        git apply -p4 "$FIXTURE_SRC/seeds/fix/${vuln_id}-fix.patch" || {
            echo "      Fix patch FAILED to apply!"
            exit 1
        }
        if ./mvnw -q -B $MVN_OPTS test > /dev/null 2>&1; then
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
while IFS='=' read -r key val; do
    printf "    %-22s %s\n" "$key" "$val"
done < "$NEW_HASHES"

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
echo "    - Junk probes verified (target/ untracked, not gitignored)"
echo "    - operator-notes.local excluded from golden, source ref retained"
echo "    - Seed refs verified (BRK: RED, BUG: seeded as designed)"
echo "    - Fix patches applied and green"
echo "    - VULN fix patches applied and green"
echo "================================================================="
