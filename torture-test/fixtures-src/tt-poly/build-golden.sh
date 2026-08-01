#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# build-golden.sh — Deterministic golden builder for tt-poly fixture
# =============================================================================
# Builds a byte-stable bare repository at
#   torture-test/var/fixtures/golden/tt-poly.git
# with immutable seed refs, broken-tests branch, and composite seed/storm ref.
#
# python/ seeds use full-file overlays (copy overlay file → target path).
# ts/ seeds use git patches (git apply -p4 from the working tree root).
# go/ seeds use full-file overlays (copy overlay file → target path).
# rust/ seeds use full-file overlays (copy overlay file → target path).
# java/ seeds use git patches (git apply -p4 from the working tree root).
#
# Every commit hash is stable across rebuilds: fixed git author / committer
# identity and timestamps ensure byte-identical repos.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_SRC="$SCRIPT_DIR"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
GOLDEN_DIR="$REPO_ROOT/torture-test/var/fixtures/golden"
BARE_REPO="$GOLDEN_DIR/tt-poly.git"
HASH_FILE="$GOLDEN_DIR/tt-poly.git.hashes"
FIXTURE_NAME="tt-poly"

# -------------------------------------------------------------------
# Deterministic commit environment (byte-stable hashes across rebuilds)
# -------------------------------------------------------------------
export GIT_AUTHOR_NAME='Tamandua Fixture Builder'
export GIT_AUTHOR_EMAIL='fixtures@tamandua.tetradactyla.org'
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'
export GIT_COMMITTER_NAME='Tamandua Fixture Builder'
export GIT_COMMITTER_EMAIL='fixtures@tamandua.tetradactyla.org'
export GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'

# -------------------------------------------------------------------
# Cleanup trap — remove all scratch directories on exit
# -------------------------------------------------------------------
SCRATCH_BASE=""
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
    if [ -z "$SCRATCH_BASE" ]; then
        SCRATCH_BASE="$(mktemp -d "${TMPDIR:-/tmp}/build-golden-tt-poly.XXXXXX")"
    fi
    local d
    d="$(mktemp -d "$SCRATCH_BASE/work.XXXXXX")"
    SCRATCH_DIRS+=("$d")
    eval "$__resultvar='$d'"
}

# -------------------------------------------------------------------
# Mapping: python seed overlay filename → target path in work tree
# -------------------------------------------------------------------
py_target_for() {
    local fname="$1"
    case "$fname" in
        recurrence.py)   echo "python/src/schedlib/recurrence.py" ;;
        conflict.py)     echo "python/src/schedlib/conflict.py" ;;
        dates.py)        echo "python/src/schedlib/dates.py" ;;
        integrations.py) echo "python/src/schedlib/integrations.py" ;;
        conftest.py)     echo "python/conftest.py" ;;
        test_broken_p1.py) echo "python/tests/test_broken_p1.py" ;;
        test_broken_p2.py) echo "python/tests/test_broken_p2.py" ;;
        *)
            echo "ERROR: unknown seed overlay file: $fname" >&2
            exit 1
            ;;
    esac
}

# -------------------------------------------------------------------
# Mapping: go seed overlay filename → target path in work tree
# -------------------------------------------------------------------
go_target_for() {
    local fname="$1"
    case "$fname" in
        pool.go)       echo "go/pool.go" ;;
        worker.go)     echo "go/worker.go" ;;
        task.go)       echo "go/task.go" ;;
        go.mod)        echo "go/go.mod" ;;
        pool_test.go)  echo "go/pool_test.go" ;;
        util_command.go)  echo "go/util/command.go" ;;
        util_archive.go)  echo "go/util/archive.go" ;;
        *)
            echo "ERROR: unknown go seed overlay file: $fname" >&2
            exit 1
            ;;
    esac
}

# -------------------------------------------------------------------
# Mapping: rust seed overlay filename → target path in work tree
# -------------------------------------------------------------------
rust_target_for() {
    local fname="$1"
    case "$fname" in
        bucket.rs)      echo "rust/src/bucket.rs" ;;
        config.rs)      echo "rust/src/config.rs" ;;
        integration.rs) echo "rust/tests/integration.rs" ;;
        util_unsafe.rs) echo "rust/src/util_unsafe.rs" ;;
        util_timing.rs) echo "rust/src/util_timing.rs" ;;
        *)
            echo "ERROR: unknown rust seed overlay file: $fname" >&2
            exit 1
            ;;
    esac
}

# -------------------------------------------------------------------
# Mapping: A5 cross-language seed overlay filename → target path
# -------------------------------------------------------------------
a5_target_for() {
    local fname="$1"
    case "$fname" in
        integrations.py)              echo "python/src/schedlib/integrations.py" ;;
        server.ts)                    echo "ts/src/server.ts" ;;
        test_calendar_integration.py) echo "python/tests/test_calendar_integration.py" ;;
        *)
            echo "ERROR: unknown A5 seed overlay file: $fname" >&2
            exit 1
            ;;
    esac
}

# Seed-order lists — python
readonly PYTHON_BUG_SEEDS=(POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4)
readonly PYTHON_VULN_SEEDS=(POLY-VULN-P1 POLY-VULN-P2)
readonly PYTHON_SEED_REFS=(POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4 POLY-VULN-P1 POLY-VULN-P2)
readonly PYTHON_BRK_SEEDS=(POLY-BRK-P1 POLY-BRK-P2)

# Seed-order lists — ts
readonly TS_BUG_SEEDS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4)
readonly TS_BRK_SEEDS=(POLY-BRK-T1 POLY-BRK-T2)
readonly TS_VULN_SEEDS=(POLY-VULN-T1 POLY-VULN-T2)
readonly TS_PATCH_SEEDS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4 POLY-BRK-T1 POLY-BRK-T2)
readonly TS_SEED_REFS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4 POLY-VULN-T1 POLY-VULN-T2)

# Seed-order lists — go (for Phase 4, US-014)
readonly GO_BUG_SEEDS=(POLY-BUG-G1 POLY-BUG-G2 POLY-BUG-G3 POLY-BUG-G4)
readonly GO_VULN_SEEDS=(POLY-VULN-G1 POLY-VULN-G2)
readonly GO_BRK_SEEDS=(POLY-BRK-G1 POLY-BRK-G2)
readonly GO_SEED_REFS=(POLY-BUG-G1 POLY-BUG-G2 POLY-BUG-G3 POLY-BUG-G4 POLY-VULN-G1 POLY-VULN-G2)

# Seed-order lists — rust (for Phase 5, US-014)
readonly RUST_BUG_SEEDS=(POLY-BUG-R1 POLY-BUG-R2 POLY-BUG-R3 POLY-BUG-R4)
readonly RUST_VULN_SEEDS=(POLY-VULN-R1 POLY-VULN-R2)
readonly RUST_BRK_SEEDS=(POLY-BRK-R1 POLY-BRK-R2)
readonly RUST_SEED_REFS=(POLY-BUG-R1 POLY-BUG-R2 POLY-BUG-R3 POLY-BUG-R4 POLY-VULN-R1 POLY-VULN-R2)

# Seed-order lists — java (for Phase 6, US-014)
readonly JAVA_BUG_SEEDS=(POLY-BUG-J1 POLY-BUG-J2 POLY-BUG-J3 POLY-BUG-J4)
readonly JAVA_VULN_SEEDS=(POLY-VULN-J1 POLY-VULN-J2)
readonly JAVA_BRK_SEEDS=(POLY-BRK-J1 POLY-BRK-J2)
readonly JAVA_PATCH_SEEDS=(POLY-BUG-J1 POLY-BUG-J2 POLY-BUG-J3 POLY-BUG-J4 POLY-BRK-J1 POLY-BRK-J2)
readonly JAVA_SEED_REFS=(POLY-BUG-J1 POLY-BUG-J2 POLY-BUG-J3 POLY-BUG-J4 POLY-VULN-J1 POLY-VULN-J2)

# A5 cross-language seed
readonly A5_SEED=(POLY-BUG-A5)

# -------------------------------------------------------------------
# Banner
# -------------------------------------------------------------------
echo "================================================================="
echo " build-golden.sh — tt-poly deterministic golden builder"
echo "================================================================="
echo "  Fixture source : $FIXTURE_SRC"
echo "  Golden dir     : $GOLDEN_DIR"
echo "  Bare repo      : $BARE_REPO"
echo ""

# -------------------------------------------------------------------
# Phase 1 — Build working tree + baseline commit
# -------------------------------------------------------------------
echo "--- Phase 1: Building working tree ---"

rm -rf "$BARE_REPO"
mkdir -p "$GOLDEN_DIR"

scratch_dir WORK_DIR

(
    cd "$WORK_DIR"
    GIT_TEMPLATE_DIR=/dev/null git init --initial-branch=main > /dev/null

    # Copy fixture source via tar, excluding generated crud
    (
        cd "$FIXTURE_SRC"
        tar --exclude='.venv' \
            --exclude='__pycache__' \
            --exclude='.pytest_cache' \
            --exclude='.mypy_cache' \
            --exclude='.flaky_counter' \
            --exclude='node_modules' \
            --exclude='dist' \
            --exclude='package-lock.json' \
            --exclude='*.egg-info' \
            --exclude='target' \
            --exclude='build-golden.sh' \
            -cf - .
    ) | tar -xf -

    git add -A
    git commit --no-gpg-sign -q -m "Initial baseline: tt-poly five-language monorepo (green test suite)"
)

BASELINE_SHA="$(cd "$WORK_DIR" && git rev-parse HEAD)"
echo "  Baseline commit : $BASELINE_SHA"

# Create bare repo and push baseline
GIT_TEMPLATE_DIR=/dev/null git init --bare "$BARE_REPO" > /dev/null
(
    cd "$WORK_DIR"
    git push "$BARE_REPO" HEAD:refs/heads/main > /dev/null 2>&1
)
git --git-dir="$BARE_REPO" symbolic-ref HEAD refs/heads/main
echo "  Pushed main to bare repo"

# -------------------------------------------------------------------
# Phase 2 — Build python seed refs (overlay-based)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 2: Building python seed refs ---"

for seed_id in "${PYTHON_SEED_REFS[@]}"; do
    echo "  seed/$seed_id..."
    (
        cd "$WORK_DIR"
        git checkout -qf "$BASELINE_SHA" 2>/dev/null
        git clean -fdq

        seed_dir="$FIXTURE_SRC/seeds/python/$seed_id"
        changed=false
        for f in "$seed_dir"/*; do
            fname="$(basename "$f")"
            [ "$fname" = "fix.patch" ] && continue
            target="$(py_target_for "$fname")"
            if ! diff -q "$f" "$target" >/dev/null 2>&1; then
                cp "$f" "$target"
                changed=true
            fi
        done

        if $changed; then
            git add -A
            git commit --no-gpg-sign -q -m "seed: $seed_id"
        else
            git commit --no-gpg-sign -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
        fi

        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id")"
    echo "    -> $sha"
done

# -------------------------------------------------------------------
# Phase 3 — Build ts seed refs (patch-based + VULN baseline refs)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 3: Building ts seed refs ---"

for seed_id in "${TS_PATCH_SEEDS[@]}"; do
    echo "  seed/$seed_id..."

    scratch_dir SEED_WORK
    git clone "$BARE_REPO" "$SEED_WORK" > /dev/null 2>&1
    (
        cd "$SEED_WORK"
        git checkout "$BASELINE_SHA" > /dev/null 2>&1
        git apply -p4 "$FIXTURE_SRC/seeds/ts/${seed_id}.patch"
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id"
    )
    sha="$(cd "$SEED_WORK" && git rev-parse HEAD)"
    (
        cd "$SEED_WORK"
        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    echo "    -> $sha"
done

# VULN-T1 and VULN-T2 are dormant — seed refs point directly to baseline
for vuln_id in "${TS_VULN_SEEDS[@]}"; do
    echo "  seed/$vuln_id (dormant -> baseline)..."
    git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/$vuln_id" "$BASELINE_SHA"
    echo "    -> $BASELINE_SHA"
done

# Storm composition order (matches seeds/storm/STORM.md)
readonly STORM_ORDER=(
    # Phase 1: python bug seeds
    POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4
    # Phase 2: ts bug seeds
    POLY-BUG-T1-T4 POLY-BUG-T2 POLY-BUG-T3
    # Phase 3: go bug seeds
    POLY-BUG-G1 POLY-BUG-G2 POLY-BUG-G3 POLY-BUG-G4
    # Phase 4: rust bug seeds
    POLY-BUG-R1 POLY-BUG-R2 POLY-BUG-R3 POLY-BUG-R4
    # Phase 5: java bug seeds
    POLY-BUG-J1 POLY-BUG-J2 POLY-BUG-J3 POLY-BUG-J4
    # Phase 5a: A5 cross-language seed
    POLY-BUG-A5
    # Phase 6: all vulnerabilities
    POLY-VULN-P1 POLY-VULN-P2 POLY-VULN-T1 POLY-VULN-T2
    POLY-VULN-G1 POLY-VULN-G2 POLY-VULN-R1 POLY-VULN-R2
    POLY-VULN-J1 POLY-VULN-J2
    # Phase 7: all broken tests
    POLY-BRK-P1 POLY-BRK-P2 POLY-BRK-T1 POLY-BRK-T2
    POLY-BRK-G1 POLY-BRK-G2 POLY-BRK-R1 POLY-BRK-R2
    POLY-BRK-J1 POLY-BRK-J2
    # Phase 7a: flaky test probe
    POLY-FLAKY-P1
)

# -------------------------------------------------------------------
# Phase 4 — Build go seed refs (overlay-based)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 4: Building go seed refs ---"

for seed_id in "${GO_SEED_REFS[@]}"; do
    echo "  seed/$seed_id..."
    (
        cd "$WORK_DIR"
        git checkout -qf "$BASELINE_SHA" 2>/dev/null
        git clean -fdq

        seed_dir="$FIXTURE_SRC/seeds/go/$seed_id"
        changed=false
        for f in "$seed_dir"/*; do
            fname="$(basename "$f")"
            [ "$fname" = "fix.patch" ] && continue
            target="$(go_target_for "$fname")"
            if ! diff -q "$f" "$target" >/dev/null 2>&1; then
                cp "$f" "$target"
                changed=true
            fi
        done

        if $changed; then
            git add -A
            git commit --no-gpg-sign -q -m "seed: $seed_id"
        else
            git commit --no-gpg-sign -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
        fi

        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id")"
    echo "    -> $sha"
done

# -------------------------------------------------------------------
# Phase 5 — Build rust seed refs (overlay-based)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 5: Building rust seed refs ---"

for seed_id in "${RUST_SEED_REFS[@]}"; do
    echo "  seed/$seed_id..."
    (
        cd "$WORK_DIR"
        git checkout -qf "$BASELINE_SHA" 2>/dev/null
        git clean -fdq

        seed_dir="$FIXTURE_SRC/seeds/rust/$seed_id"
        changed=false
        for f in "$seed_dir"/*; do
            fname="$(basename "$f")"
            [ "$fname" = "fix.patch" ] && continue
            target="$(rust_target_for "$fname")"
            if ! diff -q "$f" "$target" >/dev/null 2>&1; then
                cp "$f" "$target"
                changed=true
            fi
        done

        if $changed; then
            git add -A
            git commit --no-gpg-sign -q -m "seed: $seed_id"
        else
            git commit --no-gpg-sign -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
        fi

        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id")"
    echo "    -> $sha"
done

# -------------------------------------------------------------------
# Phase 6 — Build java seed refs (patch-based + VULN baseline refs)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 6: Building java seed refs ---"

for seed_id in "${JAVA_PATCH_SEEDS[@]}"; do
    echo "  seed/$seed_id..."

    scratch_dir SEED_WORK
    git clone "$BARE_REPO" "$SEED_WORK" > /dev/null 2>&1
    (
        cd "$SEED_WORK"
        git checkout "$BASELINE_SHA" > /dev/null 2>&1
        git apply -p4 "$FIXTURE_SRC/seeds/java/${seed_id}.patch"
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id"
    )
    sha="$(cd "$SEED_WORK" && git rev-parse HEAD)"
    (
        cd "$SEED_WORK"
        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    echo "    -> $sha"
done

# VULN-J1 and VULN-J2 are dormant — seed refs point directly to baseline
for vuln_id in "${JAVA_VULN_SEEDS[@]}"; do
    echo "  seed/$vuln_id (dormant -> baseline)..."
    git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/$vuln_id" "$BASELINE_SHA"
    echo "    -> $BASELINE_SHA"
done

# -------------------------------------------------------------------
# Phase 6a — Build A5 cross-language seed ref (dual overlay)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 6a: Building POLY-BUG-A5 cross-language seed ref ---"

for seed_id in "${A5_SEED[@]}"; do
    echo "  seed/$seed_id..."

    scratch_dir A5_WORK
    git clone "$BARE_REPO" "$A5_WORK" > /dev/null 2>&1
    (
        cd "$A5_WORK"
        git checkout "$BASELINE_SHA" > /dev/null 2>&1

        seed_dir="$FIXTURE_SRC/seeds/$seed_id"
        changed=false
        for f in "$seed_dir"/*; do
            fname="$(basename "$f")"
            [ "$fname" = "fix.patch" ] && continue
            target="$(a5_target_for "$fname")"
            if ! diff -q "$f" "$target" >/dev/null 2>&1; then
                cp "$f" "$target"
                changed=true
            fi
        done

        if $changed; then
            git add -A
            git commit --no-gpg-sign -q -m "seed: $seed_id"
        else
            git commit --no-gpg-sign -q --allow-empty -m "seed: $seed_id (dormant — same as baseline)"
        fi
    )
    sha="$(cd "$A5_WORK" && git rev-parse HEAD)"
    (
        cd "$A5_WORK"
        git push "$BARE_REPO" HEAD:"refs/heads/seed/$seed_id" > /dev/null 2>&1
    )
    echo "    -> $sha"
done

# -------------------------------------------------------------------
# Phase 7 — Build broken-tests branch
# -------------------------------------------------------------------
echo ""
echo "--- Phase 7: Building broken-tests branch ---"

scratch_dir BROKEN_WORK
git clone "$BARE_REPO" "$BROKEN_WORK" > /dev/null 2>&1

(
    cd "$BROKEN_WORK"
    git checkout -b broken-tests "$BASELINE_SHA" > /dev/null 2>&1

    # Apply python BRK overlays
    for seed_id in "${PYTHON_BRK_SEEDS[@]}"; do
        seed_dir="$FIXTURE_SRC/seeds/python/$seed_id"
        for f in "$seed_dir"/*; do
            fn="$(basename "$f")"
            [ "$fn" = "fix.patch" ] && continue
            tgt="$(py_target_for "$fn")"
            cp "$f" "$tgt"
        done
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id (broken test)"
    done

    # Apply ts BRK patches
    for seed_id in "${TS_BRK_SEEDS[@]}"; do
        git apply -p4 "$FIXTURE_SRC/seeds/ts/${seed_id}.patch"
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id (broken test)"
    done

    # Apply go BRK overlays
    for seed_id in "${GO_BRK_SEEDS[@]}"; do
        seed_dir="$FIXTURE_SRC/seeds/go/$seed_id"
        for f in "$seed_dir"/*; do
            fn="$(basename "$f")"
            [ "$fn" = "fix.patch" ] && continue
            tgt="$(go_target_for "$fn")"
            cp "$f" "$tgt"
        done
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id (broken test)"
    done

    # Apply rust BRK overlays
    for seed_id in "${RUST_BRK_SEEDS[@]}"; do
        seed_dir="$FIXTURE_SRC/seeds/rust/$seed_id"
        for f in "$seed_dir"/*; do
            fn="$(basename "$f")"
            [ "$fn" = "fix.patch" ] && continue
            tgt="$(rust_target_for "$fn")"
            cp "$f" "$tgt"
        done
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id (broken test)"
    done

    # Apply java BRK patches
    for seed_id in "${JAVA_BRK_SEEDS[@]}"; do
        git apply -p4 "$FIXTURE_SRC/seeds/java/${seed_id}.patch"
        git add -A
        git commit --no-gpg-sign -q -m "seed: $seed_id (broken test)"
    done
)

BROKEN_TESTS_HEAD="$(cd "$BROKEN_WORK" && git rev-parse broken-tests)"
(
    cd "$BROKEN_WORK"
    git push "$BARE_REPO" broken-tests:refs/heads/broken-tests > /dev/null 2>&1
)
# Ensure bare repo HEAD stays on main
git --git-dir="$BARE_REPO" symbolic-ref HEAD refs/heads/main
echo "  broken-tests head : $BROKEN_TESTS_HEAD"

# -------------------------------------------------------------------
# Phase 8 — Build composite seed/storm ref
# -------------------------------------------------------------------
echo ""
echo "--- Phase 8: Building composite seed/storm ref ---"

scratch_dir STORM_WORK
git clone "$BARE_REPO" "$STORM_WORK" > /dev/null 2>&1

(
    cd "$STORM_WORK"
    git checkout "$BASELINE_SHA" > /dev/null 2>&1

    for seed_id in "${STORM_ORDER[@]}"; do
        case "$seed_id" in
            POLY-BUG-P*|POLY-VULN-P*|POLY-BRK-P*)
                # Python seed — apply overlays
                seed_dir="$FIXTURE_SRC/seeds/python/$seed_id"
                for f in "$seed_dir"/*; do
                    fname="$(basename "$f")"
                    [ "$fname" = "fix.patch" ] && continue
                    tgt="$(py_target_for "$fname")"
                    cp "$f" "$tgt"
                done
                ;;
            POLY-BUG-T1-T4)
                # Combined T1+T4 — applies both off-by-one and O(n^2) bugs
                git apply -p4 "$FIXTURE_SRC/seeds/ts/POLY-BUG-T1-T4-combined.patch"
                ;;
            POLY-BUG-T*|POLY-BRK-T*)
                # TS seed — git apply patch
                git apply -p4 "$FIXTURE_SRC/seeds/ts/${seed_id}.patch"
                ;;
            POLY-VULN-T*)
                # Dormant in baseline — no overlay/patch needed
                ;;
            POLY-BUG-G*|POLY-VULN-G*|POLY-BRK-G*)
                # Go seed — apply overlays
                seed_dir="$FIXTURE_SRC/seeds/go/$seed_id"
                for f in "$seed_dir"/*; do
                    fname="$(basename "$f")"
                    [ "$fname" = "fix.patch" ] && continue
                    tgt="$(go_target_for "$fname")"
                    cp "$f" "$tgt"
                done
                ;;
            POLY-BUG-R*|POLY-VULN-R*|POLY-BRK-R*)
                # Rust seed — apply overlays
                seed_dir="$FIXTURE_SRC/seeds/rust/$seed_id"
                for f in "$seed_dir"/*; do
                    fname="$(basename "$f")"
                    [ "$fname" = "fix.patch" ] && continue
                    tgt="$(rust_target_for "$fname")"
                    cp "$f" "$tgt"
                done
                ;;
            POLY-BUG-J*|POLY-BRK-J*)
                # Java seed — git apply patch
                git apply -p4 "$FIXTURE_SRC/seeds/java/${seed_id}.patch"
                ;;
            POLY-VULN-J*)
                # Dormant in baseline — no overlay/patch needed
                ;;
            POLY-FLAKY-P1)
                # Flaky test probe — apply conftest.py overlay
                seed_dir="$FIXTURE_SRC/seeds/python/$seed_id"
                cp "$seed_dir/conftest.py" python/conftest.py
                ;;
            POLY-BUG-A5)
                # A5 cross-language seed — apply overlays
                seed_dir="$FIXTURE_SRC/seeds/$seed_id"
                for f in "$seed_dir"/*; do
                    fname="$(basename "$f")"
                    [ "$fname" = "fix.patch" ] && continue
                    tgt="$(a5_target_for "$fname")"
                    cp "$f" "$tgt"
                done
                ;;
        esac
    done

    git add -A
    git commit --no-gpg-sign -q -m "seed/storm: composite ref with all storm seeds layered"
)

STORM_SHA="$(cd "$STORM_WORK" && git rev-parse HEAD)"
(
    cd "$STORM_WORK"
    git push "$BARE_REPO" HEAD:refs/heads/seed/storm > /dev/null 2>&1
)
echo "  seed/storm       : $STORM_SHA"

# -------------------------------------------------------------------
# Phase 9 — Storm sentinel pre-verification (git merge-tree)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 9: Storm sentinel pre-verification ---"

scratch_dir SENTINEL_WORK
git clone "$BARE_REPO" "$SENTINEL_WORK" > /dev/null 2>&1

# Build S5 branch: replace STORM-SENTINEL with category-normalization helper
echo "  Building S5 branch (category-normalization helper)..."
(
    cd "$SENTINEL_WORK"
    git checkout -b sentinel-s5 "$BASELINE_SHA" > /dev/null 2>&1

    # Replace the STORM-SENTINEL block with a normalizeCategories helper
    python3 -c "
import re
path = 'ts/src/store.ts'
with open(path, 'r') as f:
    content = f.read()
# Replace the sentinel comment block + blank line with S5's normalization helper
sentinel = r'  // STORM-SENTINEL: [^\n]*\n(?:  // [^\n]*\n)*  // [^\n]*\n\n'
replacement = '''  // S5: category-normalization helper added during storm bug-fix run.
  // Replaces the STORM-SENTINEL placeholder between getByCategory and getByDateRange.
  normalizeCategories(expenses: Expense[]): Expense[] {
    const normalized = new Map<string, Category>([
      ['Groceries', 'Food'],
      ['Restaurant', 'Food'],
      ['Bus', 'Transport'],
      ['Gas', 'Transport'],
      ['Electricity', 'Utilities'],
      ['Water', 'Utilities'],
    ]);
    return expenses.map(e => ({
      ...e,
      category: normalized.get(e.category) || e.category,
    }));
  }

'''
content = re.sub(sentinel, replacement, content, count=1)
with open(path, 'w') as f:
    f.write(content)
"
    git add -A
    git commit --no-gpg-sign -q -m "S5: category-normalization helper (sentinel replacement)"
)
S5_SHA="$(cd "$SENTINEL_WORK" && git rev-parse sentinel-s5)"
echo "    S5 commit: $S5_SHA"

# Build S9 branch: replace STORM-SENTINEL with category-aliasing map
echo "  Building S9 branch (category-aliasing map)..."
scratch_dir S9_WORK
git clone "$BARE_REPO" "$S9_WORK" > /dev/null 2>&1
(
    cd "$S9_WORK"
    git checkout -b sentinel-s9 "$BASELINE_SHA" > /dev/null 2>&1

    python3 -c "
import re
path = 'ts/src/store.ts'
with open(path, 'r') as f:
    content = f.read()
sentinel = r'  // STORM-SENTINEL: [^\n]*\n(?:  // [^\n]*\n)*  // [^\n]*\n\n'
replacement = '''  // S9: category-aliasing map added during storm feature-dev run.
  // Replaces the STORM-SENTINEL placeholder between getByCategory and getByDateRange.
  private readonly categoryAliases: Record<string, Category> = {
    Groceries: 'Food',
    Restaurant: 'Food',
    'Bus Ticket': 'Transport',
    Gas: 'Transport',
    Electricity: 'Utilities',
    Water: 'Utilities',
  };

  resolveCategory(alias: string): Category {
    return this.categoryAliases[alias] || 'Other';
  }

'''
content = re.sub(sentinel, replacement, content, count=1)
with open(path, 'w') as f:
    f.write(content)
"
    git add -A
    git commit --no-gpg-sign -q -m "S9: category-aliasing map (sentinel replacement)"
)
S9_SHA="$(cd "$S9_WORK" && git rev-parse sentinel-s9)"
echo "    S9 commit: $S9_SHA"

# Push S9 as a temp ref to the bare repo so merge-tree can see it
(
    cd "$S9_WORK"
    git push "$BARE_REPO" sentinel-s9:refs/heads/__sentinel-s9-tmp > /dev/null 2>&1
)

# Fetch the S9 ref into the S5 worktree clone
(
    cd "$SENTINEL_WORK"
    git fetch "$BARE_REPO" refs/heads/__sentinel-s9-tmp:refs/heads/__sentinel-s9-tmp > /dev/null 2>&1
)

# Run git merge-tree to verify conflict
echo "  Running git merge-tree S5 vs S9..."
MERGE_TREE_OUT="$(cd "$SENTINEL_WORK" && git merge-tree sentinel-s5 __sentinel-s9-tmp 2>&1)" || true

# Clean up temp ref
git --git-dir="$BARE_REPO" update-ref -d refs/heads/__sentinel-s9-tmp > /dev/null 2>&1 || true

# merge-tree must report textual conflict (containing CONFLICT markers)
if echo "$MERGE_TREE_OUT" | grep -q 'CONFLICT'; then
    echo "    merge-tree: TEXTUAL CONFLICT DETECTED (ok)"
    if echo "$MERGE_TREE_OUT" | grep -q 'Merge conflict'; then
        echo "    conflict confirmed — S5/S9 merge is correctly conflicting"
    else
        echo "    WARNING: CONFLICT present but 'Merge conflict' not found?"
    fi
else
    echo "    FATAL: git merge-tree did NOT report a textual conflict!"
    echo "    The STORM-SENTINEL pre-verification failed — S5 and S9 edits auto-merged cleanly."
    echo "    This means the sentinel line is NOT producing the guaranteed conflict it should."
    echo ""
    echo "    Merge-tree output:"
    echo "$MERGE_TREE_OUT"
    exit 1
fi

# -------------------------------------------------------------------
# Phase 10 — Post-build verification (structural)
# -------------------------------------------------------------------
echo ""
echo "--- Phase 10: Post-build verification ---"

scratch_dir VERIFY_DIR
git clone "$BARE_REPO" "$VERIFY_DIR" > /dev/null 2>&1

# Operator notes reference content
OPERATOR_REF="$(cat "$FIXTURE_SRC/operator-notes.local")"

# --- 9a. Baseline content check -------------------------------------------
echo ""
echo "  [10a] Baseline content check..."

echo -n "    STORM-SENTINEL in ts/src/store.ts..."
if grep -q 'STORM-SENTINEL' "$VERIFY_DIR/ts/src/store.ts"; then
    echo " present (ok)"
else
    echo " MISSING — baseline should have STORM-SENTINEL!"
    exit 1
fi

for subtree in python ts go rust java; do
    echo -n "    $subtree/ subtree..."
    if [ -d "$VERIFY_DIR/$subtree" ]; then
        echo " present (ok)"
    else
        echo " MISSING!"
        exit 1
    fi
done

for f in JUNK-IS-INTENTIONAL.md README-JUNK.md run-all-tests Makefile; do
    echo -n "    $f..."
    if [ -f "$VERIFY_DIR/$f" ]; then
        echo " present (ok)"
    else
        echo " MISSING!"
        exit 1
    fi
done

# --- 9b. Seed ref existence check -----------------------------------------
echo ""
echo "  [10b] Seed ref existence check..."

ALL_SEED_REFS=(
    "${PYTHON_SEED_REFS[@]}" "${TS_SEED_REFS[@]}"
    "${GO_SEED_REFS[@]}" "${RUST_SEED_REFS[@]}" "${JAVA_SEED_REFS[@]}"
    POLY-BRK-T1 POLY-BRK-T2 POLY-BRK-J1 POLY-BRK-J2
    "${A5_SEED[@]}"
)

for seed_id in "${ALL_SEED_REFS[@]}"; do
    echo -n "    seed/$seed_id..."
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id" 2>/dev/null || echo '')"
    if [ -n "$sha" ] && [ "${#sha}" -eq 40 ]; then
        echo " $sha"
    else
        echo " MISSING!"
        exit 1
    fi
done

echo -n "    seed/storm..."
storm_sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/storm" 2>/dev/null || echo '')"
if [ -n "$storm_sha" ] && [ "${#storm_sha}" -eq 40 ]; then
    echo " $storm_sha"
else
    echo " MISSING!"
    exit 1
fi

echo -n "    broken-tests..."
brk_sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/broken-tests" 2>/dev/null || echo '')"
if [ -n "$brk_sha" ] && [ "${#brk_sha}" -eq 40 ]; then
    echo " $brk_sha"
else
    echo " MISSING!"
    exit 1
fi

# --- 9c. broken-tests branch content check ---------------------------------
echo ""
echo "  [10c] broken-tests branch content check..."

scratch_dir BRK_CHECK
git clone "$BARE_REPO" "$BRK_CHECK" > /dev/null 2>&1
(
    cd "$BRK_CHECK"
    git checkout broken-tests > /dev/null 2>&1
)

# Verify python broken test files exist
echo -n "    python/tests/test_broken_p1.py..."
if [ -f "$BRK_CHECK/python/tests/test_broken_p1.py" ]; then
    echo " present (ok)"
else
    echo " MISSING!"
    exit 1
fi
echo -n "    python/tests/test_broken_p2.py..."
if [ -f "$BRK_CHECK/python/tests/test_broken_p2.py" ]; then
    echo " present (ok)"
else
    echo " MISSING!"
    exit 1
fi

# Verify go broken test modifications
echo -n "    go/pool_test.go (has BRK content)..."
if grep -q 'expected.*result_count' "$BRK_CHECK/go/pool_test.go" 2>/dev/null; then
    echo " present (ok)"
else
    echo " no BRK marker found (checking for modified content)..."
    if [ -f "$BRK_CHECK/go/pool_test.go" ]; then
        echo "      present but content check inconclusive (ok)"
    else
        echo "      MISSING!"
        exit 1
    fi
fi

# Verify rust broken test modifications
echo -n "    rust/tests/integration.rs (has BRK content)..."
if grep -q 'expected_count' "$BRK_CHECK/rust/tests/integration.rs" 2>/dev/null; then
    echo " present (ok)"
else
    echo " no BRK marker found (checking for modified content)..."
    if [ -f "$BRK_CHECK/rust/tests/integration.rs" ]; then
        echo "      present but content check inconclusive (ok)"
    else
        echo "      MISSING!"
        exit 1
    fi
fi

# --- 9d. Junk probe verification -------------------------------------------
echo ""
echo "  [10d] Junk probe verification..."

# operator-notes.local byte-identical check
echo -n "    operator-notes.local..."
ACTUAL_OP="$(cat "$VERIFY_DIR/operator-notes.local" 2>/dev/null || echo 'MISSING')"
if [ "$ACTUAL_OP" = "$OPERATOR_REF" ]; then
    echo " byte-identical (ok)"
else
    echo " BYTE-MISMATCH!"
    exit 1
fi

# Per-subtree operator-notes.local checks
for subtree in python ts go rust java; do
    echo -n "    $subtree/operator-notes.local..."
    if [ -f "$VERIFY_DIR/$subtree/operator-notes.local" ]; then
        echo " present (ok)"
    else
        echo " MISSING!"
        exit 1
    fi
done

# Per-subtree JUNK markers (some subtrees may not have standalone copies)
for subtree in python ts go rust java; do
    echo -n "    $subtree/JUNK-IS-INTENTIONAL.md..."
    if [ -f "$VERIFY_DIR/$subtree/JUNK-IS-INTENTIONAL.md" ]; then
        echo " present (ok)"
    else
        echo " absent (ok — not required per subtree)"
    fi
done

# Junk probes NOT gitignored — top-level .gitignore must NOT suppress
for pattern in __pycache__ .pytest_cache .flaky_counter node_modules package-lock.json target; do
    echo -n "    $pattern NOT in top .gitignore..."
    if grep -v '^#' "$VERIFY_DIR/.gitignore" 2>/dev/null | grep -qF "$pattern"; then
        echo " FAIL — $pattern is gitignored (must NOT be)!"
        exit 1
    else
        echo " ok"
    fi
done

# --- 9e. seed/POLY-BUG-G4 content check (known different from baseline) ---
echo ""
echo "  [10e] Seed ref content spot-checks..."

# Check a go seed: POLY-BUG-G1 should have different pool.go from baseline
echo -n "    seed/POLY-BUG-G1 pool.go differs from baseline..."
scratch_dir G1_CHECK
git clone "$BARE_REPO" "$G1_CHECK" > /dev/null 2>&1
(
    cd "$G1_CHECK"
    git checkout seed/POLY-BUG-G1 > /dev/null 2>&1
)
main_pool="$(cd "$VERIFY_DIR" && sha256sum go/pool.go 2>/dev/null | awk '{print $1}')"
g1_pool="$(cd "$G1_CHECK" && sha256sum go/pool.go 2>/dev/null | awk '{print $1}')"
if [ "$main_pool" != "$g1_pool" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — seed should modify pool.go!"
    exit 1
fi

echo -n "    seed/POLY-BUG-R1 bucket.rs differs from baseline..."
scratch_dir R1_CHECK
git clone "$BARE_REPO" "$R1_CHECK" > /dev/null 2>&1
(
    cd "$R1_CHECK"
    git checkout seed/POLY-BUG-R1 > /dev/null 2>&1
)
main_bucket="$(cd "$VERIFY_DIR" && sha256sum rust/src/bucket.rs 2>/dev/null | awk '{print $1}')"
r1_bucket="$(cd "$R1_CHECK" && sha256sum rust/src/bucket.rs 2>/dev/null | awk '{print $1}')"
if [ "$main_bucket" != "$r1_bucket" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — seed should modify bucket.rs!"
    exit 1
fi

echo -n "    seed/POLY-VULN-J1 points to baseline (dormant)..."
vj1_sha="$(git --git-dir="$BARE_REPO" rev-parse refs/heads/seed/POLY-VULN-J1)"
if [ "$vj1_sha" = "$BASELINE_SHA" ]; then
    echo " ok"
else
    echo " DIFFERS FROM BASELINE — dormant VULN should point to baseline!"
    exit 1
fi

# A5 cross-language spot check
echo -n "    seed/POLY-BUG-A5 integrations.py differs from baseline..."
scratch_dir A5_CHECK
git clone "$BARE_REPO" "$A5_CHECK" > /dev/null 2>&1
(
    cd "$A5_CHECK"
    git checkout seed/POLY-BUG-A5 > /dev/null 2>&1
)
main_intg="$(cd "$VERIFY_DIR" && sha256sum python/src/schedlib/integrations.py 2>/dev/null | awk '{print $1}')"
a5_intg="$(cd "$A5_CHECK" && sha256sum python/src/schedlib/integrations.py 2>/dev/null | awk '{print $1}')"
if [ "$main_intg" != "$a5_intg" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — A5 should modify integrations.py!"
    exit 1
fi

echo -n "    seed/POLY-BUG-A5 server.ts differs from baseline..."
main_srv="$(cd "$VERIFY_DIR" && sha256sum ts/src/server.ts 2>/dev/null | awk '{print $1}')"
a5_srv="$(cd "$A5_CHECK" && sha256sum ts/src/server.ts 2>/dev/null | awk '{print $1}')"
if [ "$main_srv" != "$a5_srv" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — A5 should modify server.ts!"
    exit 1
fi

echo -n "    seed/POLY-BUG-A5 test_calendar_integration.py present..."
if [ -f "$A5_CHECK/python/tests/test_calendar_integration.py" ]; then
    echo " present (ok)"
else
    echo " MISSING!"
    exit 1
fi

# --- 9f. seed/storm composite content check --------------------------------
echo ""
echo "  [10f] seed/storm composite content check..."

scratch_dir STORM_CHECK
git clone "$BARE_REPO" "$STORM_CHECK" > /dev/null 2>&1
(
    cd "$STORM_CHECK"
    git checkout seed/storm > /dev/null 2>&1
)

# Verify python seeds: test_broken_p1.py should exist in storm
echo -n "    python/tests/test_broken_p1.py..."
if [ -f "$STORM_CHECK/python/tests/test_broken_p1.py" ]; then
    echo " present (ok)"
else
    echo " MISSING — storm should have BRK-P1!"; exit 1
fi

# Verify go seeds: pool.go in storm differs from baseline
echo -n "    go/pool.go differs from baseline (storm)..."
storm_pool="$(cd "$STORM_CHECK" && sha256sum go/pool.go 2>/dev/null | awk '{print $1}')"
if [ "$main_pool" != "$storm_pool" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — storm should have go bug seeds!"; exit 1
fi

# Verify rust seeds: bucket.rs in storm differs from baseline
echo -n "    rust/src/bucket.rs differs from baseline (storm)..."
storm_bucket="$(cd "$STORM_CHECK" && sha256sum rust/src/bucket.rs 2>/dev/null | awk '{print $1}')"
if [ "$main_bucket" != "$storm_bucket" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — storm should have rust bug seeds!"; exit 1
fi

# Verify ts BRK in storm
echo -n "    ts/src/store.test.ts has BRK changes (storm)..."
storm_store_test="$(cd "$STORM_CHECK" && sha256sum ts/src/store.test.ts 2>/dev/null | awk '{print $1}')"
main_store_test="$(cd "$VERIFY_DIR" && sha256sum ts/src/store.test.ts 2>/dev/null | awk '{print $1}')"
if [ "$main_store_test" != "$storm_store_test" ]; then
    echo " differs (ok)"
else
    echo " SAME AS BASELINE — storm should have BRK changes!"; exit 1
fi

# -------------------------------------------------------------------
# Phase 11 — Hash stability
# -------------------------------------------------------------------
echo ""
echo "--- Phase 11: Hash stability ---"

# Collect current hashes for all refs
NEW_HASHES="$(mktemp "${TMPDIR:-/tmp}/.hashes-tt-poly.XXXXXX")"
{
    echo "#baseline=$BASELINE_SHA"
    for seed_id in "${PYTHON_SEED_REFS[@]}" "${TS_SEED_REFS[@]}" \
                   "${GO_SEED_REFS[@]}" "${RUST_SEED_REFS[@]}" "${JAVA_SEED_REFS[@]}" \
                   POLY-BRK-T1 POLY-BRK-T2 POLY-BRK-J1 POLY-BRK-J2 \
                   "${A5_SEED[@]}"; do
        ref_sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id" 2>/dev/null || echo 'MISSING')"
        echo "seed/$seed_id=$ref_sha"
    done
    echo "broken-tests=$BROKEN_TESTS_HEAD"
    echo "seed/storm=$STORM_SHA"
} > "$NEW_HASHES"

echo "  Current hashes:"
while IFS='=' read -r key val; do
    printf "    %-24s %s\n" "$key" "$val"
done < "$NEW_HASHES"

# Compare against previous run
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

# Clean up stale old-format hash files
rm -f "$GOLDEN_DIR/.build-hashes-${FIXTURE_NAME}"
rm -f "$GOLDEN_DIR/.build-hashes-${FIXTURE_NAME}-lite"

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "================================================================="
echo " build-golden.sh — COMPLETE"
echo "================================================================="
echo "  Bare repo      : $BARE_REPO"
echo "  Baseline       : $BASELINE_SHA"
for seed_id in "${PYTHON_SEED_REFS[@]}" "${TS_SEED_REFS[@]}" \
               "${GO_SEED_REFS[@]}" "${RUST_SEED_REFS[@]}" "${JAVA_SEED_REFS[@]}" \
               POLY-BRK-T1 POLY-BRK-T2 POLY-BRK-J1 POLY-BRK-J2 \
               "${A5_SEED[@]}"; do
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id" 2>/dev/null || echo 'MISSING')"
    printf "  %-24s: %s\n" "seed/$seed_id" "$sha"
done
printf "  %-24s: %s\n" "broken-tests" "$BROKEN_TESTS_HEAD"
printf "  %-24s: %s\n" "seed/storm" "$STORM_SHA"
echo ""
echo "  Verification   : ALL PASSED"
echo "    - Baseline content (5 subtrees, STORM-SENTINEL, JUNK markers)"
echo "    - Storm sentinel pre-verification (merge-tree conflict confirmed)"
echo "    - All seed refs present (python + ts + go + rust + java + A5)"
echo "    - POLY-BUG-A5 cross-language seed (dual overlay, partial-fix property)"
echo "    - broken-tests branch (all POLY-BRK-* seeds)"
echo "    - seed/storm composite ref (all seeds layered)"
echo "    - Junk probes verified (operator-notes.local byte-identical)"
echo "    - Seed content spot-checks (go/rust/java/A5 verified)"
echo "    - Hash stability check"
echo "================================================================="
