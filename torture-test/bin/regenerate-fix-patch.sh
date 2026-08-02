#!/usr/bin/env bash
# regenerate-fix-patch.sh — Mechanical fix patch regeneration
#
# Clones a golden bare repo, applies a seed overlay, and captures the
# resulting git diff as a mechanically correct fix patch. The generated
# patch has correct hunk headers (counts match body lines) because git
# diff produces them by construction — unlike hand-edited patches that
# suffer from hunk-body mismatches.
#
# Usage:
#   regenerate-fix-patch.sh <golden-bare> <seed-dir> <fix-patch-output> [OPTIONS]
#
# Arguments:
#   golden-bare       Path to the golden bare repo (.git directory)
#   seed-dir          Path to the seed directory containing overlay files
#   fix-patch-output  Path where the generated fix.patch will be written
#
# Options:
#   --cwd <subdir>    For monorepo fixtures, restrict file matching to
#                     this subdirectory (e.g., python/)
#   --branch <name>   Check out this branch instead of the default branch
#                     (e.g., --branch broken-tests). Required for BRK seeds
#                     that live on a non-default branch in the golden bare.
#   --map <name=path> Map a seed overlay file to a different target path
#                     (e.g., --map util_command.go=util/command.go).
#                     May be repeated for multiple files.
#
# Examples:
#   # Single-language fixture (tt-go) with path mapping:
#   regenerate-fix-patch.sh var/fixtures/golden/tt-go.git \
#       fixtures-src/tt-go/seeds/VULN-G1 \
#       fixtures-src/tt-go/seeds/VULN-G1/fix.patch \
#       --map util_command.go=util/command.go
#
#   # Monorepo fixture (tt-poly-lite/python):
#   regenerate-fix-patch.sh var/fixtures/golden/tt-poly-lite.git \
#       fixtures-src/tt-poly-lite/python/seeds/POLY-BUG-P1 \
#       fixtures-src/tt-poly-lite/python/seeds/POLY-BUG-P1/fix.patch \
#       --cwd python/
#
# The seed overlay application mirrors validate-all.sh's apply_seed logic:
# files from the seed dir (excluding fix.patch, SEEDS.md, .gitkeep, go.mod)
# are copied to matching targets found by basename within the working tree.
# When --map is provided, the specified file uses the mapped path instead.
#
# Uses git add -A + git diff --cached -R HEAD to capture new files (e.g.,
# worker.go added by a seed that doesn't exist in the green baseline).
#
# Verifies the generated patch applies cleanly with git apply --check
# in a fresh clone of the golden bare after seeding.

set -euo pipefail

# ── Help ───────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n '1,/^$/p' "$0" | head -n -1
    exit 0
fi

# ── Argument parsing ───────────────────────────────────────────────
if [ $# -lt 3 ]; then
    echo "ERROR: missing required arguments" >&2
    echo "Usage: $0 <golden-bare> <seed-dir> <fix-patch-output> [OPTIONS]" >&2
    echo "Run with --help for full documentation." >&2
    exit 2
fi

GOLDEN_BARE="$1"
SEED_DIR="$2"
FIX_PATCH_OUTPUT="$(realpath "$3")"
CWD=""
BRANCH=""

# Collect --map entries: associative array not available in all bash
# versions (4.0+); use two parallel arrays.
declare -a MAP_FROM=()
declare -a MAP_TO=()

shift 3
while [ $# -gt 0 ]; do
    case "$1" in
        --cwd)
            if [ $# -lt 2 ]; then
                echo "ERROR: --cwd requires a value" >&2
                exit 2
            fi
            CWD="$2"
            shift 2
            ;;
        --branch)
            if [ $# -lt 2 ]; then
                echo "ERROR: --branch requires a value" >&2
                exit 2
            fi
            BRANCH="$2"
            shift 2
            ;;
        --map)
            if [ $# -lt 2 ]; then
                echo "ERROR: --map requires a value" >&2
                exit 2
            fi
            # Split name=path
            name="${2%%=*}"
            path="${2#*=}"
            if [ -z "$name" ] || [ -z "$path" ] || [ "$name" = "$2" ]; then
                echo "ERROR: --map requires name=path format (e.g., --map util_command.go=util/command.go)" >&2
                exit 2
            fi
            MAP_FROM+=("$name")
            MAP_TO+=("$path")
            shift 2
            ;;
        *)
            echo "ERROR: unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 2
            ;;
    esac
done

# ── Input validation ───────────────────────────────────────────────
if [ ! -d "$GOLDEN_BARE" ]; then
    echo "ERROR: golden bare not found at: $GOLDEN_BARE" >&2
    exit 1
fi

if [ ! -d "$SEED_DIR" ]; then
    echo "ERROR: seed directory not found at: $SEED_DIR" >&2
    exit 1
fi

# ── Helper: resolve target path for a seed file ────────────────────
resolve_target() {
    local work_dir="$1" bn="$2"
    local target=""

    # Check --map entries first
    local i
    for i in "${!MAP_FROM[@]}"; do
        if [ "${MAP_FROM[$i]}" = "$bn" ]; then
            target="$work_dir/${MAP_TO[$i]}"
            break
        fi
    done

    if [ -z "$target" ]; then
        # Find by basename, excluding seeds/ and build artifacts
        local search_root="$work_dir"
        [ -n "$CWD" ] && search_root="$work_dir/$CWD"
        target=$(find "$search_root" -type f -name "$bn" \
            -not -path '*/.git/*' \
            -not -path '*/seeds/*' \
            -not -path '*/node_modules/*' \
            -not -path '*/target/*' \
            -not -path '*/__pycache__/*' \
            -not -path '*/.venv/*' \
            -not -path '*/vendor/*' \
            -not -path '*/dist/*' \
            2>/dev/null | head -1)
        if [ -z "$target" ]; then
            # New file — place at root of workspace
            target="$work_dir/$bn"
        fi
    fi

    echo "$target"
}

# ── Helper: apply seed overlay files to a workspace ────────────────
apply_seed_overlay() {
    local work_dir="$1"
    local applied=0

    for f in "$SEED_DIR"/*; do
        [ -f "$f" ] || continue
        bn="$(basename "$f")"
        case "$bn" in
            fix.patch|SEEDS.md|.gitkeep) continue ;;
            go.mod) continue ;;  # artifact file, not a real overlay (skipped by builder)
        esac

        target=$(resolve_target "$work_dir" "$bn")
        mkdir -p "$(dirname "$target")" 2>/dev/null || true
        # Strip //go:build ignore header from Go seed files.
        # The tag prevents compilation when the seed lives in
        # fixtures-src, but the target must compile after overlay.
        if head -1 "$f" 2>/dev/null | grep -q '^//go:build ignore$'; then
            tail -n +2 "$f" | sed '1{/^$/d;}' > "$target"
        else
            cp "$f" "$target"
        fi
        applied=$((applied + 1))
    done
    echo "$applied"
}

# ── Prepare temp workspace ─────────────────────────────────────────
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/regenerate-fix-patch.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

if ! git clone -q "$GOLDEN_BARE" "$WORK_DIR" 2>/dev/null; then
    echo "ERROR: failed to clone golden bare from: $GOLDEN_BARE" >&2
    exit 1
fi

# Checkout the specified branch if --branch was given
if [ -n "$BRANCH" ]; then
    if ! (cd "$WORK_DIR" && git checkout -q "$BRANCH" 2>/dev/null); then
        echo "ERROR: branch not found in golden bare: $BRANCH" >&2
        exit 1
    fi
fi

# Validate --cwd early
if [ -n "$CWD" ] && [ ! -d "$WORK_DIR/$CWD" ]; then
    echo "ERROR: --cwd subdirectory not found in workspace: $CWD" >&2
    exit 1
fi

# ── Apply seed overlay ─────────────────────────────────────────────
applied_count=$(apply_seed_overlay "$WORK_DIR")

if [ "$applied_count" -eq 0 ]; then
    echo "ERROR: no overlay files found in seed directory (excluding fix.patch/SEEDS.md/.gitkeep/go.mod)" >&2
    exit 1
fi

# ── Generate fix patch via git diff ────────────────────────────────
# The seed overlay introduces a bug (green baseline → buggy state).
# The fix patch should go the OPPOSITE direction (buggy → green).
# Use git add -A to stage new files so git diff sees them, then
# git diff --cached -R HEAD captures buggy → green.
(
    cd "$WORK_DIR"
    git add -A 2>/dev/null || true
    git diff --cached -R HEAD > "$FIX_PATCH_OUTPUT" || true
)

if [ ! -s "$FIX_PATCH_OUTPUT" ]; then
    echo "ERROR: generated fix patch is empty — seed overlay produced no changes" >&2
    echo "  (this may indicate a dormant seed where the buggy code already matches the baseline)" >&2
    exit 1
fi

# ── Verify patch applies cleanly ───────────────────────────────────
# The fix patch must apply to a golden bare clone AFTER the seed
# overlay has been applied (buggy → green).
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/regenerate-verify.XXXXXX")"
cleanup_verify() { rm -rf "$VERIFY_DIR"; }
trap 'cleanup_verify; cleanup' EXIT

if ! git clone -q "$GOLDEN_BARE" "$VERIFY_DIR" 2>/dev/null; then
    echo "ERROR: failed to clone golden bare for verification" >&2
    exit 1
fi

# Checkout the same branch for verification (if specified)
if [ -n "$BRANCH" ]; then
    (cd "$VERIFY_DIR" && git checkout -q "$BRANCH" 2>/dev/null) || true
fi

# Apply the same seed overlay to the verification clone
verify_applied=$(apply_seed_overlay "$VERIFY_DIR" 2>/dev/null) || true

# Determine -p level from patch format
p_level="-p0"
if grep -m1 '^--- ' "$FIX_PATCH_OUTPUT" 2>/dev/null | grep -qE '^--- [ab]/'; then
    p_level="-p1"
fi

# Now the verification clone has the seed overlay applied (buggy).
# The fix patch should apply cleanly to restore green.
if ! (cd "$VERIFY_DIR" && git apply --check $p_level "$FIX_PATCH_OUTPUT" 2>&1); then
    echo "ERROR: generated fix patch does not apply cleanly with git apply --check" >&2
    echo "  (verified on seeded clone from: $GOLDEN_BARE, p-level: $p_level)" >&2
    echo "  Patch output written to: $FIX_PATCH_OUTPUT" >&2
    exit 1
fi

echo "Fix patch generated and verified: $FIX_PATCH_OUTPUT"
echo "  Overlay files applied: $applied_count"
echo "  p-level: $p_level"
echo "  Patch applies cleanly: yes"
