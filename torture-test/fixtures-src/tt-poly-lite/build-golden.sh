#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# build-golden.sh — Deterministic golden builder for tt-poly-lite fixture
# =============================================================================
# Builds a byte-stable bare repository at
#   torture-test/var/fixtures/golden/tt-poly-lite.git
# with immutable seed refs, broken-tests branch, and composite seed/storm ref.
#
# python/ seeds use full-file overlays (copy overlay file → target path).
# ts/ seeds use git patches (git apply -p4 from the working tree root).
#
# Every commit hash is stable across rebuilds: fixed git author / committer
# identity and timestamps ensure byte-identical repos.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_SRC="$SCRIPT_DIR"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
GOLDEN_DIR="${TORTURE_GOLDEN_DIR:-$REPO_ROOT/torture-test/var/fixtures/golden}"
BARE_REPO="$GOLDEN_DIR/tt-poly-lite.git"
HASH_FILE="$GOLDEN_DIR/tt-poly-lite.git.hashes"

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
        SCRATCH_BASE="$(mktemp -d "${TMPDIR:-/tmp}/build-golden-tt-poly-lite.XXXXXX")"
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

# Seed-order lists
readonly PYTHON_BUG_SEEDS=(POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4)
readonly PYTHON_VULN_SEEDS=(POLY-VULN-P1 POLY-VULN-P2)
readonly PYTHON_SEED_REFS=(POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4 POLY-VULN-P1 POLY-VULN-P2)
readonly PYTHON_BRK_SEEDS=(POLY-BRK-P1 POLY-BRK-P2)

readonly TS_BUG_SEEDS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4)
readonly TS_BRK_SEEDS=(POLY-BRK-T1 POLY-BRK-T2)
readonly TS_VULN_SEEDS=(POLY-VULN-T1 POLY-VULN-T2)
readonly TS_PATCH_SEEDS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4 POLY-BRK-T1 POLY-BRK-T2)
readonly TS_SEED_REFS=(POLY-BUG-T1 POLY-BUG-T2 POLY-BUG-T3 POLY-BUG-T4 POLY-VULN-T1 POLY-VULN-T2)

# Storm composition order (matches seeds/storm/STORM.md)
readonly STORM_ORDER=(
    POLY-BUG-P1 POLY-BUG-P2 POLY-BUG-P3 POLY-BUG-P4
    POLY-BUG-T1-T4 POLY-BUG-T2 POLY-BUG-T3
    POLY-VULN-P1 POLY-VULN-P2 POLY-VULN-T1 POLY-VULN-T2
    POLY-BRK-P1 POLY-BRK-P2 POLY-BRK-T1 POLY-BRK-T2
)

# -------------------------------------------------------------------
# Banner
# -------------------------------------------------------------------
echo "================================================================="
echo " build-golden.sh — tt-poly-lite deterministic golden builder"
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
            --exclude='build-golden.sh' \
            --exclude='operator-notes.local' \
            -cf - .
    ) | tar -xf -

    git add -A
    git commit --no-gpg-sign -q -m "Initial baseline: tt-poly-lite two-language monorepo (green test suite)"
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

        seed_dir="$FIXTURE_SRC/python/seeds/$seed_id"
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
# Phase 3 — Build ts seed refs (patch-based)
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
        git apply -p4 "$FIXTURE_SRC/ts/seeds/${seed_id}.patch"
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
for vuln_id in POLY-VULN-T1 POLY-VULN-T2; do
    echo "  seed/$vuln_id (dormant -> baseline)..."
    git --git-dir="$BARE_REPO" update-ref "refs/heads/seed/$vuln_id" "$BASELINE_SHA"
    echo "    -> $BASELINE_SHA"
done

# -------------------------------------------------------------------
# Phase 4 — Build broken-tests branch
# -------------------------------------------------------------------
echo ""
echo "--- Phase 4: Building broken-tests branch ---"

scratch_dir BROKEN_WORK
git clone "$BARE_REPO" "$BROKEN_WORK" > /dev/null 2>&1

(
    cd "$BROKEN_WORK"
    git checkout -b broken-tests "$BASELINE_SHA" > /dev/null 2>&1

    # Apply python BRK overlays
    for seed_id in POLY-BRK-P1 POLY-BRK-P2; do
        seed_dir="$FIXTURE_SRC/python/seeds/$seed_id"
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
    for seed_id in POLY-BRK-T1 POLY-BRK-T2; do
        git apply -p4 "$FIXTURE_SRC/ts/seeds/${seed_id}.patch"
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
# Phase 5 — Bare repo ready; HEAD already set to main
# -------------------------------------------------------------------
echo ""
echo "--- Phase 5: Bare repo ready ---"
echo "  Bare repo        : $BARE_REPO"
echo "  HEAD             : refs/heads/main"

# -------------------------------------------------------------------
# Phase 6 — Post-build verification
# -------------------------------------------------------------------
echo ""
echo "--- Phase 6: Post-build verification ---"

scratch_dir VERIFY_DIR
git clone "$BARE_REPO" "$VERIFY_DIR" > /dev/null 2>&1

# --- 6a. Baseline green check (both suites) --------------------------------
echo ""
echo "  [6a] Baseline green check..."

# Python suite
echo -n "    python/..."
(
    cd "$VERIFY_DIR"
    # US-007: capture bootstrap/pytest output and surface the tail on
    # failure instead of swallowing to /dev/null and failing generically.
    if ! BOOT_OUT="$(bash python/bootstrap 2>&1)"; then
        echo " FAILED — python bootstrap failed!"
        echo "    ── last lines of bootstrap output ──"
        printf '%s\n' "$BOOT_OUT" | tail -20
        exit 1
    fi
    if PYTEST_OUT="$(cd python && .venv/bin/python -m pytest -q --tb=short 2>&1)"; then
        echo " GREEN"
    else
        echo " FAILED — python baseline suite is not green!"
        echo "    ── last lines of pytest output ──"
        printf '%s\n' "$PYTEST_OUT" | tail -20
        exit 1
    fi
)

# TS suite
echo -n "    ts/..."
(
    cd "$VERIFY_DIR/ts"
    if ! INSTALL_OUT="$(npm install 2>&1)"; then
        echo " FAILED — npm install failed!"
        echo "      ── last lines of npm install output ──"
        printf '%s\n' "$INSTALL_OUT" | tail -20
        exit 1
    fi
    if TEST_OUT="$(npm test 2>&1)"; then
        echo "      GREEN"
    else
        echo "      FAILED — ts baseline suite is not green!"
        echo "      ── last lines of npm test output ──"
        printf '%s\n' "$TEST_OUT" | tail -20
        exit 1
    fi
)

# --- 6b. broken-tests branch red check ------------------------------------
echo ""
echo "  [6b] broken-tests branch check..."

(
    cd "$VERIFY_DIR"
    git checkout broken-tests > /dev/null 2>&1
)

echo -n "    python/..."
(
    cd "$VERIFY_DIR"
    if PYTEST_OUT="$(cd python && .venv/bin/python -m pytest -q --tb=short 2>&1)"; then
        echo " UNEXPECTED GREEN — broken-tests branch should be red!"
        echo "    ── last lines of pytest output ──"
        printf '%s\n' "$PYTEST_OUT" | tail -20
        exit 1
    else
        echo " RED (expected)"
    fi
)

echo -n "    ts/..."
(
    cd "$VERIFY_DIR/ts"
    if TEST_OUT="$(npm test 2>&1)"; then
        echo "      UNEXPECTED GREEN — broken-tests branch should be red!"
        echo "      ── last lines of npm test output ──"
        printf '%s\n' "$TEST_OUT" | tail -20
        exit 1
    else
        echo "      RED (expected)"
    fi
)

# --- 6c. Junk probe verification (on baseline checkout) -------------------
echo ""
echo "  [6c] Junk probe verification..."

(
    cd "$VERIFY_DIR"
    git checkout main > /dev/null 2>&1
)

# MACP2: the python-subtree __pycache__ junk is a DETERMINISTIC PROVISIONING
# ARTIFACT, not an interpreter side effect — Apple's Python bakes in
# sys.pycache_prefix and ALWAYS redirects bytecode caches out-of-tree, so
# in-tree python/__pycache__ can never be relied on. Seed the byte-exact
# fixtures-src reference into the verify clone BEFORE the test run; the marker
# file is what the oracle checks (present + untracked + byte-identical).
JUNK_REF="$FIXTURE_SRC/python/__pycache__/junk-probe.synthetic"
mkdir -p "$VERIFY_DIR/python/__pycache__"
cp "$JUNK_REF" "$VERIFY_DIR/python/__pycache__/junk-probe.synthetic"

# Run a quick test cycle to regenerate the interpreter-written junk
# (.pytest_cache, .flaky_counter) — Darwin-safe.
echo -n "    Generating python junk..."
(cd "$VERIFY_DIR/python" && .venv/bin/python -m pytest -q --tb=short > /dev/null 2>&1) || true
echo " done"

JUNK_OK=true

# Seeded synthetic python/__pycache__ junk: present, untracked, byte-identical
# to the fixtures-src reference. Absence is NO LONGER tolerated — the probe
# must never silently weaken on hosts where the interpreter redirects bytecode
# caches out-of-tree (Apple's sys.pycache_prefix).
if [ ! -f "$VERIFY_DIR/python/__pycache__/junk-probe.synthetic" ]; then
    echo "    python/__pycache__/junk-probe.synthetic : MISSING — seeded junk absent (probe weakened)!"
    JUNK_OK=false
elif JUNK_TRACKED="$(cd "$VERIFY_DIR" && git ls-files --error-unmatch python/__pycache__/junk-probe.synthetic 2>&1)"; then
    echo "    python/__pycache__/junk-probe.synthetic : TRACKED — junk probe failure!"
    echo "    ── git ls-files output ──"
    printf '%s\n' "$JUNK_TRACKED" | tail -20
    JUNK_OK=false
elif ! cmp -s "$JUNK_REF" "$VERIFY_DIR/python/__pycache__/junk-probe.synthetic"; then
    echo "    python/__pycache__/junk-probe.synthetic : BYTE-MISMATCH — differs from the fixtures-src reference!"
    JUNK_OK=false
else
    echo "    python/__pycache__/ : present, untracked, byte-identical (seeded synthetic junk)"
fi

# The fixture SOURCE synthetic reference is the byte-exact provisioning
# reference (same pattern as operator-notes.local) — it must be retained.
if [ ! -s "$JUNK_REF" ]; then
    echo "    python/__pycache__/junk-probe.synthetic : fixture source missing/empty — provisioning reference lost!"
    JUNK_OK=false
else
    echo "    python/__pycache__/junk-probe.synthetic : fixture source retained (byte-exact provisioning ref)"
fi

# python/ regenerated junk probes: .pytest_cache/, .flaky_counter (absence
# tolerated — they are interpreter/pytest side effects, Darwin-safe)
for junk_path in "python/.pytest_cache" "python/.flaky_counter"; do
    junk_name="$(basename "$junk_path")"
    if [ -e "$VERIFY_DIR/$junk_path" ]; then
        if (cd "$VERIFY_DIR" && git status --porcelain "$junk_path" 2>/dev/null | grep -q '^??'); then
            echo "    $junk_path : UNTRACKED (ok)"
        elif JUNK_STATUS="$(cd "$VERIFY_DIR" && git status --porcelain "$junk_path" 2>/dev/null)" \
             && printf '%s\n' "$JUNK_STATUS" | grep -q '^[^?]'; then
            echo "    $junk_path : TRACKED — junk probe failure!"
            echo "    ── git status output ──"
            printf '%s\n' "$JUNK_STATUS" | tail -20
            exit 1
        else
            echo "    $junk_path : present but status unclear — checking .gitignore..."
            if grep -v '^#' "$VERIFY_DIR/.gitignore" 2>/dev/null | grep -qF "$junk_name"; then
                echo "    $junk_path : FAIL — gitignored in root (must NOT be)!"
                exit 1
            fi
            if [ -f "$VERIFY_DIR/python/.gitignore" ]; then
                if grep -v '^#' "$VERIFY_DIR/python/.gitignore" 2>/dev/null | grep -qF "$junk_name"; then
                    echo "    $junk_path : FAIL — gitignored in python/.gitignore (must NOT be)!"
                    exit 1
                fi
            fi
            echo "    $junk_path : OK (not gitignored)"
        fi
    else
        # Must NOT be gitignored
        echo "    $junk_path : absent — checking .gitignore..."
        if grep -v '^#' "$VERIFY_DIR/.gitignore" 2>/dev/null | grep -qF "$junk_name"; then
            echo "    $junk_path : FAIL — gitignored in root (must NOT be)!"
            exit 1
        fi
        if [ -f "$VERIFY_DIR/python/.gitignore" ]; then
            if grep -v '^#' "$VERIFY_DIR/python/.gitignore" 2>/dev/null | grep -qF "$junk_name"; then
                echo "    $junk_path : FAIL — gitignored in python/.gitignore (must NOT be)!"
                exit 1
            fi
        fi
        echo "    $junk_path : OK (not gitignored)"
    fi
done

# python/__pycache__ must NOT be gitignored (root or python/.gitignore) — a
# gitignored junk probe is a distinct failure mode (spec 02: junk probes must
# NOT be suppressed by .gitignore).
for gi in "$VERIFY_DIR/.gitignore" "$VERIFY_DIR/python/.gitignore"; do
    if [ -f "$gi" ]; then
        if grep -v '^#' "$gi" 2>/dev/null | grep -qF '__pycache__'; then
            echo "    python/__pycache__ : FAIL — gitignored in $(basename "$gi") (must NOT be)!"
            JUNK_OK=false
        fi
    fi
done

if ! $JUNK_OK; then
    exit 1
fi

# ts/ junk probes (run tests to generate them)
echo -n "    Generating ts junk..."
(cd "$VERIFY_DIR/ts" && npm test > /dev/null 2>&1) || true
echo " done"

# package-lock.json
echo -n "    ts/package-lock.json..."
if [ -f "$VERIFY_DIR/ts/package-lock.json" ]; then
    if (cd "$VERIFY_DIR" && git status --porcelain ts/package-lock.json 2>/dev/null | grep -q '^??'); then
        echo " UNTRACKED (ok)"
    elif JUNK_STATUS="$(cd "$VERIFY_DIR" && git status --porcelain ts/package-lock.json 2>/dev/null)" \
         && printf '%s\n' "$JUNK_STATUS" | grep -q '^[^?]'; then
        echo " TRACKED — junk probe failure!"
        echo "    ── git status output ──"
        printf '%s\n' "$JUNK_STATUS" | tail -20
        exit 1
    else
        echo " status unclear — checking .gitignore..."
        if grep -v '^#' "$VERIFY_DIR/ts/.gitignore" 2>/dev/null | grep -q 'package-lock.json'; then
            echo "    ts/package-lock.json : FAIL — gitignored (must NOT be)!"
            exit 1
        fi
        echo "    ts/package-lock.json : OK (not gitignored)"
    fi
else
    # Check it's not gitignored
    if grep -v '^#' "$VERIFY_DIR/ts/.gitignore" 2>/dev/null | grep -q 'package-lock.json'; then
        echo "    ts/package-lock.json : FAIL — gitignored (must NOT be)!"
        exit 1
    fi
    echo "    ts/package-lock.json : OK (not gitignored)"
fi

# node_modules/
echo -n "    ts/node_modules/..."
if [ -d "$VERIFY_DIR/ts/node_modules" ]; then
    if (cd "$VERIFY_DIR" && git status --porcelain ts/node_modules/ 2>/dev/null | head -1 | grep -q '^??'); then
        echo "     UNTRACKED (ok)"
    elif JUNK_STATUS="$(cd "$VERIFY_DIR" && git status --porcelain ts/node_modules/ 2>/dev/null)" \
         && printf '%s\n' "$JUNK_STATUS" | grep -q '^[^?]'; then
        echo "     TRACKED — junk probe failure!"
        echo "     ── git status output ──"
        printf '%s\n' "$JUNK_STATUS" | tail -20
        exit 1
    else
        echo "     status unclear — checking .gitignore..."
        if grep -v '^#' "$VERIFY_DIR/ts/.gitignore" 2>/dev/null | grep -q 'node_modules'; then
            echo "    ts/node_modules/ : FAIL — gitignored (must NOT be)!"
            exit 1
        fi
        echo "    ts/node_modules/ : OK (not gitignored)"
    fi
else
    if grep -v '^#' "$VERIFY_DIR/ts/.gitignore" 2>/dev/null | grep -q 'node_modules'; then
        echo "    ts/node_modules/ : FAIL — gitignored (must NOT be)!"
        exit 1
    fi
    echo "    ts/node_modules/ : OK (not gitignored)"
fi

# operator-notes.local must NOT be in the golden tree — it is inert junk
# planted at provisioning (spec 02), never committed.
echo -n "    operator-notes.local in golden..."
if [ -e "$VERIFY_DIR/operator-notes.local" ]; then
    echo " PRESENT — should be excluded junk!"
    exit 1
else
    echo " absent (ok)"
fi

# The fixture SOURCE operator-notes.local is the byte-exact provisioning
# reference (spec 02: planted at instantiation, byte-identical). The canonical
# bytes must be retained so provisioning can plant them into work clones.
if [ ! -s "$FIXTURE_SRC/operator-notes.local" ]; then
    echo "    operator-notes.local : fixture source missing/empty — provisioning reference lost!"
    exit 1
else
    echo "    operator-notes.local : fixture source retained (byte-exact provisioning ref)"
fi

# --- 6d. Python seed ref verification -------------------------------------
echo ""
echo "  [6d] Python seed ref verification..."

for seed_id in "${PYTHON_BUG_SEEDS[@]}" "${PYTHON_VULN_SEEDS[@]}"; do
    scratch_dir PY_VERIFY
    git clone "$BARE_REPO" "$PY_VERIFY" > /dev/null 2>&1
    (
        cd "$PY_VERIFY"
        git checkout "seed/$seed_id" > /dev/null 2>&1
        # US-007: surface the bootstrap tail on failure instead of a
        # silent set -e abort.
        if ! BOOT_OUT="$(bash python/bootstrap 2>&1)"; then
            echo "    $seed_id: python bootstrap FAILED!"
            echo "    ── last lines of bootstrap output ──"
            printf '%s\n' "$BOOT_OUT" | tail -20
            exit 1
        fi
    )

    if [ "${seed_id:0:7}" = "POLY-BU" ]; then
        echo -n "    $seed_id (BUG)..."
        set +e
        OUT="$(cd "$PY_VERIFY/python" && .venv/bin/python -m pytest -q --tb=short 2>&1)"
        EXIT=$?
        set -e
        if [ "$EXIT" -eq 0 ]; then
            echo " GREEN (dormant — ok)"
        elif [ "$seed_id" = "POLY-BUG-P2" ]; then
            echo " RED with failures (P2 has active bugs by design — ok)"
        elif [ "$seed_id" = "POLY-BUG-P3" ]; then
            echo " RED with failures (P3 has active bugs by design — ok)"
        elif [ "$seed_id" = "POLY-BUG-P4" ]; then
            echo " RED with failures (P4 has performance bug by design — ok)"
        else
            echo " UNEXPECTED RED (exit=$EXIT)!"
            echo "$OUT" | tail -15
            exit 1
        fi

        # Apply fix patch — must be GREEN
        echo -n "      +fix..."
        (
            cd "$PY_VERIFY"
            fix="$FIXTURE_SRC/python/seeds/$seed_id/fix.patch"
            (patch -p1 -s --batch < "$fix") || {
                echo " Fix patch FAILED to apply!"
                exit 1
            }
        )
        if FIX_OUT="$(cd "$PY_VERIFY/python" && .venv/bin/python -m pytest -q --tb=short 2>&1)"; then
            echo " GREEN"
        else
            echo " FAILED — fix did not restore green!"
            echo "    ── last lines of pytest output ──"
            printf '%s\n' "$FIX_OUT" | tail -20
            exit 1
        fi
    else
        # VULN seeds — dormant (green baseline)
        echo -n "    $seed_id (VULN — dormant)..."
        if VULN_OUT="$(cd "$PY_VERIFY/python" && .venv/bin/python -m pytest -q --tb=short 2>&1)"; then
            echo " GREEN (dormant — ok)"
        else
            echo " UNEXPECTED RED!"
            echo "    ── last lines of pytest output ──"
            printf '%s\n' "$VULN_OUT" | tail -20
            exit 1
        fi

        # Apply fix patch — must stay GREEN
        echo -n "      +fix..."
        (
            cd "$PY_VERIFY"
            fix="$FIXTURE_SRC/python/seeds/$seed_id/fix.patch"
            (patch -p1 -s --batch < "$fix") || {
                echo " Fix patch FAILED to apply!"
                exit 1
            }
        )
        if FIX_OUT="$(cd "$PY_VERIFY/python" && .venv/bin/python -m pytest -q --tb=short 2>&1)"; then
            echo " GREEN"
        else
            echo " FAILED — VULN fix should not break the suite!"
            echo "    ── last lines of pytest output ──"
            printf '%s\n' "$FIX_OUT" | tail -20
            exit 1
        fi
    fi
done

# --- 6e. TS seed ref verification -----------------------------------------
echo ""
echo "  [6e] TS seed ref verification..."

for seed_id in "${TS_BUG_SEEDS[@]}" "${TS_BRK_SEEDS[@]}"; do
    scratch_dir TS_VERIFY
    git clone "$BARE_REPO" "$TS_VERIFY" > /dev/null 2>&1

    (
        cd "$TS_VERIFY"
        git checkout "seed/$seed_id" > /dev/null 2>&1
        if ! INSTALL_OUT="$(cd ts && npm install 2>&1)"; then
            echo "    $seed_id: npm install FAILED!"
            echo "    ── last lines of npm install output ──"
            printf '%s\n' "$INSTALL_OUT" | tail -20
            exit 1
        fi
    )

    if [ "${seed_id:0:7}" = "POLY-BU" ]; then
        echo -n "    $seed_id (BUG)..."
        set +e
        OUT="$(cd "$TS_VERIFY/ts" && npm test 2>&1)"
        EXIT=$?
        set -e
        if [ "$EXIT" -eq 0 ]; then
            echo " GREEN (dormant — ok)"
        else
            echo " UNEXPECTED RED (exit=$EXIT) — BUG seed should be dormant!"
            echo "$OUT" | tail -15
            exit 1
        fi
    else
        # BRK seeds must be RED
        echo -n "    $seed_id (BRK)..."
        set +e
        OUT="$(cd "$TS_VERIFY/ts" && npm test 2>&1)"
        EXIT=$?
        set -e
        if [ "$EXIT" -ne 0 ]; then
            echo " RED (exit=$EXIT — ok)"
        else
            echo " UNEXPECTED GREEN — BRK seed should fail!"
            echo "    ── last lines of npm test output ──"
            printf '%s\n' "$OUT" | tail -20
            exit 1
        fi
    fi

    # Apply fix patch — must be GREEN
    echo -n "      +fix..."
    (
        cd "$TS_VERIFY"
        fix="$FIXTURE_SRC/ts/seeds/fix/${seed_id}-fix.patch"
        git apply -p4 "$fix" || {
            echo " Fix patch FAILED to apply!"
            exit 1
        }
    )
    if FIX_OUT="$(cd "$TS_VERIFY/ts" && npm test 2>&1)"; then
        echo " GREEN"
    else
        echo " FAILED — fix did not restore green!"
        echo "    ── last lines of npm test output ──"
        printf '%s\n' "$FIX_OUT" | tail -20
        exit 1
    fi
done

# --- 6f. TS VULN fix verification -----------------------------------------
echo ""
echo "  [6f] TS VULN fix verification (applied directly to baseline)..."

for vuln_id in POLY-VULN-T1 POLY-VULN-T2; do
    echo -n "    $vuln_id..."

    scratch_dir VULN_VERIFY
    git clone "$BARE_REPO" "$VULN_VERIFY" > /dev/null 2>&1
    (
        cd "$VULN_VERIFY"
        if ! INSTALL_OUT="$(cd ts && npm install 2>&1)"; then
            echo "    $vuln_id: npm install FAILED!"
            echo "    ── last lines of npm install output ──"
            printf '%s\n' "$INSTALL_OUT" | tail -20
            exit 1
        fi
        fix="$FIXTURE_SRC/ts/seeds/fix/${vuln_id}-fix.patch"
        git apply -p4 "$fix" || {
            echo " Fix patch FAILED to apply!"
            exit 1
        }
        if FIX_OUT="$(cd ts && npm test 2>&1)"; then
            echo " GREEN"
        else
            echo " FAILED — VULN fix broke the suite!"
            echo "    ── last lines of npm test output ──"
            printf '%s\n' "$FIX_OUT" | tail -20
            exit 1
        fi
    )
done

# -------------------------------------------------------------------
# Phase 7 — Build composite seed/storm ref
# -------------------------------------------------------------------
echo ""
echo "--- Phase 7: Building composite seed/storm ref ---"

scratch_dir STORM_WORK
git clone "$BARE_REPO" "$STORM_WORK" > /dev/null 2>&1

(
    cd "$STORM_WORK"
    git checkout "$BASELINE_SHA" > /dev/null 2>&1

    for seed_id in "${STORM_ORDER[@]}"; do
        case "$seed_id" in
            POLY-BUG-P*|POLY-VULN-P*|POLY-BRK-P*)
                # Python seed — apply overlays
                seed_dir="$FIXTURE_SRC/python/seeds/$seed_id"
                for f in "$seed_dir"/*; do
                    fname="$(basename "$f")"
                    [ "$fname" = "fix.patch" ] && continue
                    tgt="$(py_target_for "$fname")"
                    cp "$f" "$tgt"
                done
                ;;
            POLY-BUG-T1-T4)
                # Combined T1+T4 — applies both off-by-one and O(n^2) bugs
                git apply -p4 "$FIXTURE_SRC/ts/seeds/POLY-BUG-T1-T4-combined.patch"
                ;;
            POLY-BUG-T*|POLY-BRK-T*)
                # TS seed — git apply patch
                git apply -p4 "$FIXTURE_SRC/ts/seeds/${seed_id}.patch"
                ;;
            POLY-VULN-T*)
                # Dormant in baseline — no overlay/patch needed
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
# Phase 8 — Hash stability
# -------------------------------------------------------------------
echo ""
echo "--- Phase 8: Hash stability ---"

# Collect current hashes
NEW_HASHES="$(mktemp "${TMPDIR:-/tmp}/.hashes-tt-poly-lite.XXXXXX")"
{
    echo "baseline=$BASELINE_SHA"
    for seed_id in "${PYTHON_SEED_REFS[@]}" "${TS_SEED_REFS[@]}"; do
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

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "================================================================="
echo " build-golden.sh — COMPLETE"
echo "================================================================="
echo "  Bare repo      : $BARE_REPO"
echo "  Baseline       : $BASELINE_SHA"
for seed_id in "${PYTHON_SEED_REFS[@]}" "${TS_SEED_REFS[@]}"; do
    sha="$(git --git-dir="$BARE_REPO" rev-parse "refs/heads/seed/$seed_id" 2>/dev/null || echo 'MISSING')"
    printf "  %-24s: %s\n" "seed/$seed_id" "$sha"
done
printf "  %-24s: %s\n" "broken-tests" "$BROKEN_TESTS_HEAD"
printf "  %-24s: %s\n" "seed/storm" "$STORM_SHA"
echo ""
echo "  Verification   : ALL PASSED"
echo "    - Baseline green (python + ts)"
echo "    - broken-tests branch red"
echo "    - Junk probes verified (seeded python/__pycache__ junk present/untracked/byte-identical, regenerated junk untracked)"
echo "    - operator-notes.local excluded from golden, source ref retained"
echo "    - Python seed refs verified (BUG: dormant/active, VULN: dormant, fix green)"
echo "    - TS seed refs verified (BUG: dormant, BRK: red, fix green)"
echo "    - TS VULN fixes applied and green"
echo "    - seed/storm composite ref built"
echo "================================================================="
