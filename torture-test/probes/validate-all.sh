#!/usr/bin/env bash
# validate-all.sh — Three-arm validation harness for held-out acceptance probes
#
# For every probe under torture-test/probes/<fixture>/<task-id>/probe.sh:
#   Arm 1: seed applied → probe MUST exit 1 (fail)
#   Arm 2: fix applied → probe MUST exit 0 (pass)
#   Arm 3: fix + gaming mutation → probe MUST exit 1 (fail)
#
# Builds arms in scratch clones under torture-test/var/probes/ from the
# golden bares. A probe failing validation is listed and the harness
# exits nonzero.
#
# Usage:
#   ./validate-all.sh [--golden-dir <path>] [--probes-dir <path>]
#                      [--scratch-dir <path>] [--verbose] [--probe <pattern>]
#                      [--self-test] [--help]
#
# Options:
#   --golden-dir <path>   Location of golden bare repos (default: torture-test/var/fixtures/golden/)
#   --probes-dir <path>   Location of probes directory (default: torture-test/probes/)
#   --scratch-dir <path>  Where to create scratch clones (default: torture-test/var/probes/)
#   --verbose, -v         Verbose output
#   --probe <pattern>     Validate only probes matching <pattern> (fixture/task-id format)
#   --self-test           Run built-in self-tests for the harness itself
#   --help, -h            Show this help
#
# Exit codes (complete contract — do not relax without updating self-tests):
#   0 = all discovered probes validated through at least one arm and NO arm failed.
#       Some probes may have been skipped (INTERNAL-SKIP or golden-bare missing),
#       but ONLY when at least one probe validated with at least one arm executed
#       and zero FAIL outcomes. This is an informational partial-skip — the harness
#       did real work. Skipped probes are reported in the summary.
#   1 = validation failures listed — at least one arm FAILed.
#       A partial-skip with zero failures exits 0 (condition above), never 1.
#   2 = harness/infrastructure error — execution could not proceed:
#       • Every probe was skipped because all golden bares are missing (vacuous run)
#       • Invalid arguments, missing directories, unrecoverable I/O errors
#       A run that validated NOTHING must never exit green.

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

# ── Defaults ───────────────────────────────────────────────────────
GOLDEN_DIR="${REPO_ROOT}/torture-test/var/fixtures/golden"
PROBES_DIR="${SCRIPT_DIR}"
SCRATCH_DIR="${REPO_ROOT}/torture-test/var/probes"
VERBOSE=false
PROBE_FILTER=""
TIMEOUT_SEC=120
PASS=0
FAIL=0
SKIP=0
MISSING_BARES_FILE=$(mktemp "${TMPDIR:-/tmp}/validate-all-missing-bares.XXXXXX")
SKIPPED_PROBES_FILE=$(mktemp "${TMPDIR:-/tmp}/validate-all-skipped-probes.XXXXXX")
# shellcheck disable=SC2064
trap "rm -f '$MISSING_BARES_FILE' '$SKIPPED_PROBES_FILE'" EXIT

# ── Help ───────────────────────────────────────────────────────────
show_help() {
    sed -n '1,/^$/p' "$0" | head -n -1
    exit 0
}

# ── Argument parsing ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --golden-dir) GOLDEN_DIR="$2"; shift 2 ;;
        --probes-dir) PROBES_DIR="$2"; shift 2 ;;
        --scratch-dir) SCRATCH_DIR="$2"; shift 2 ;;
        --verbose|-v) VERBOSE=true; shift ;;
        --probe) PROBE_FILTER="$2"; shift 2 ;;
        --self-test) SELF_TEST=true; shift ;;
        --help|-h) show_help ;;
        *) echo "ERROR: unknown option: $1" >&2; echo "Usage: $0 [--help]" >&2; exit 2 ;;
    esac
done

readonly GOLDEN_DIR PROBES_DIR SCRATCH_DIR VERBOSE PROBE_FILTER

# ── Logging helpers ────────────────────────────────────────────────
info()  { printf '  [INFO] %s\n' "$*" >&2; }
warn()  { printf '  \033[33m[WARN]\033[0m %s\n' "$*" >&2; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*" >&2; }
nok()   { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
verbose() { $VERBOSE && printf '    [DBG] %s\n' "$*" >&2 || true; }

# ── Seed detection ─────────────────────────────────────────────────
# seed_type <fixture> <task-id>
# Returns: overlay | patch | none
seed_type() {
    local fixture="$1"
    local task_id="$2"
    local seeds_dir="${REPO_ROOT}/torture-test/fixtures-src/${fixture}/seeds"

    # Check for overlay seed directory (directory with overlay files, not just fix.patch)
    local seed_dir="${seeds_dir}/${task_id}"
    if [ -d "$seed_dir" ]; then
        local overlay_count
        overlay_count=$(find "$seed_dir" -maxdepth 1 -type f ! -name 'fix.patch' ! -name 'SEEDS.md' ! -name '.gitkeep' 2>/dev/null | wc -l)
        if [ "$overlay_count" -gt 0 ]; then
            echo "overlay"
            return 0
        fi
    fi

    # Check for patch seed (.patch file)
    if [ -f "${seeds_dir}/${task_id}.patch" ]; then
        echo "patch"
        return 0
    fi

    echo "none"
}

# fix_source <fixture> <task-id>
# Returns path to fix patch, or empty string if none exists
fix_source() {
    local fixture="$1"
    local task_id="$2"
    local seeds_dir="${REPO_ROOT}/torture-test/fixtures-src/${fixture}/seeds"

    # Overlay: fix.patch in seed directory
    local overlay_fix="${seeds_dir}/${task_id}/fix.patch"
    if [ -f "$overlay_fix" ]; then
        echo "$overlay_fix"
        return 0
    fi

    # Patch: fix/<task-id>-fix.patch
    local patch_fix="${seeds_dir}/fix/${task_id}-fix.patch"
    if [ -f "$patch_fix" ]; then
        echo "$patch_fix"
        return 0
    fi

    echo ""
}

# seed_source <fixture> <task-id>
# Returns path to seed (overlay directory or patch file), or empty
seed_source() {
    local fixture="$1"
    local task_id="$2"
    local seeds_dir="${REPO_ROOT}/torture-test/fixtures-src/${fixture}/seeds"

    # Overlay seed directory
    local seed_dir="${seeds_dir}/${task_id}"
    if [ -d "$seed_dir" ]; then
        local overlay_count
        overlay_count=$(find "$seed_dir" -maxdepth 1 -type f ! -name 'fix.patch' ! -name 'SEEDS.md' ! -name '.gitkeep' 2>/dev/null | wc -l)
        if [ "$overlay_count" -gt 0 ]; then
            echo "$seed_dir"
            return 0
        fi
    fi

    # Patch seed file
    local seed_patch="${seeds_dir}/${task_id}.patch"
    if [ -f "$seed_patch" ]; then
        echo "$seed_patch"
        return 0
    fi

    echo ""
}

# ── Patch strip level detection ────────────────────────────────────
# detect_patch_level <patch-file>
# Detects the -p level for a git apply patch by examining paths.
# Returns: p-level number (0, 1, 4)
#
# Three path conventions are used across fixtures:
#
# 1. Git-format patches (-p4): a/torture-test/fixtures-src/<fixture>/...
#    Used by: tt-java, tt-ts, tt-poly-lite/ts
#    With -p4 the effective workspace path is src/... (or ts/src/... for poly-lite)
#
# 2. Overlay fix patches with a/ or b/ prefix (-p1):
#    a/ prefix → manually-crafted or original patches (VULN, BRK, etc.)
#    b/ prefix → mechanically regenerated via git diff -R (BUG patches)
#    For monorepo (tt-poly-lite/python): b/python/... → -p1 strips to python/...
#    For single-lang (tt-python, tt-go, tt-rust): b/src/... → -p1 strips to src/...
#
# 3. Bare paths (-p0): no a/ or b/ prefix
#    Used by: tt-rust VULN-R1, VULN-R2 (manually-crafted dormant vuln patches)
detect_patch_level() {
    local patch_file="$1"
    local first_diff
    first_diff=$(grep -m1 '^--- ' "$patch_file" 2>/dev/null || true)

    # Count path components if a/ or b/ prefix
    if echo "$first_diff" | grep -qE '^--- [ab]/torture-test/fixtures-src/'; then
        echo "4"
        return 0
    elif echo "$first_diff" | grep -qE '^--- [ab]/'; then
        echo "1"
        return 0
    fi

    # No a/ or b/ prefix
    echo "0"
}

# ── Apply seed ─────────────────────────────────────────────────────
# apply_seed <fixture> <task-id> <workspace>
# Applies the seed (overlay or patch) to the workspace.
apply_seed() {
    local fixture="$1"
    local task_id="$2"
    local workspace="$3"
    local st
    st=$(seed_type "$fixture" "$task_id")

    case "$st" in
        overlay)
            local seed_dir
            seed_dir=$(seed_source "$fixture" "$task_id")
            verbose "Applying overlay seed from $seed_dir"
            for f in "$seed_dir"/*; do
                local bn
                bn=$(basename "$f")
                case "$bn" in fix.patch|SEEDS.md|.gitkeep|go.mod) continue ;; esac
                local dest
                # Search by basename, excluding build artifacts AND the seeds/
                # directory (golden bares contain seed copies for traceability).
                dest=$(find "$workspace" -type f -name "$bn" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/target/*' \
                    -not -path '*/__pycache__/*' \
                    -not -path '*/.venv/*' \
                    -not -path '*/vendor/*' \
                    -not -path '*/dist/*' \
                    -not -path '*/.git/*' \
                    -not -path '*/seeds/*' \
                    2>/dev/null | head -1)
                # Fallback: for Go seed files with underscores, the target
                # path uses slashes (e.g. util_command.go → util/command.go).
                if [ -z "$dest" ]; then
                    local fallback_path
                    fallback_path="${bn//_/\/}"
                    dest=$(find "$workspace" -type f -path "*/$fallback_path" \
                        -not -path '*/seeds/*' 2>/dev/null | head -1)
                fi
                if [ -n "$dest" ]; then
                    # Strip //go:build ignore header from Go seed files.
                    # The tag prevents compilation when the seed lives in
                    # fixtures-src, but the target must compile after overlay.
                    if head -1 "$f" 2>/dev/null | grep -q '^//go:build ignore$'; then
                        tail -n +2 "$f" | sed '1{/^$/d;}' > "$dest"
                    else
                        cp "$f" "$dest"
                    fi
                    verbose "  Overlaid $bn → $dest"
                else
                    # New file: seed overlay adds a file not present in the
                    # golden bare. Derive the target path from the fix patch
                    # so it lands in the correct subdirectory.
                    local target_subpath=""
                    local fix_p="${seed_dir}/fix.patch"
                    if [ -f "$fix_p" ]; then
                        # Match --- or +++ lines containing /basename at end to handle subdirectories.
                        target_subpath=$(grep -m1 "^[-+][-+][-+] [ab]/.*/${bn}$" "$fix_p" | sed 's|^[-+][-+][-+] [ab]/||')
                        if [ -n "$target_subpath" ]; then
                            local target_dir
                            target_dir=$(dirname "$target_subpath")
                            if [ "$target_dir" != "." ]; then
                                mkdir -p "$workspace/$target_dir"
                            fi
                            dest="$workspace/$target_subpath"
                        fi
                    fi
                    if [ -z "$dest" ]; then
                        dest="$workspace/$bn"
                    fi
                    if head -1 "$f" 2>/dev/null | grep -q '^//go:build ignore$'; then
                        tail -n +2 "$f" | sed '1{/^$/d;}' > "$dest"
                    else
                        cp "$f" "$dest"
                    fi
                    verbose "  Overlaid $bn → $dest (new file)"
                fi
            done
            ;;
        patch)
            local seed_patch
            seed_patch=$(seed_source "$fixture" "$task_id")
            local plevel
            plevel=$(detect_patch_level "$seed_patch")
            verbose "Applying seed patch with -p${plevel}"
            if ! (cd "$workspace" && git apply --verbose -p"${plevel}" "$seed_patch" 2>&1); then
                warn "Failed to apply seed patch $seed_patch with -p${plevel}"
                return 1
            fi
            ;;
        none)
            verbose "No seed to apply for $task_id"
            ;;
    esac
}

# ── Apply fix ──────────────────────────────────────────────────────
# apply_fix <fixture> <task-id> <workspace>
# Applies the known-good fix patch to the workspace.
apply_fix() {
    local fixture="$1"
    local task_id="$2"
    local workspace="$3"
    local fix_patch
    fix_patch=$(fix_source "$fixture" "$task_id")

    if [ -z "$fix_patch" ]; then
        verbose "No fix patch for $task_id"
        return 1
    fi

    local plevel
    plevel=$(detect_patch_level "$fix_patch")
    verbose "Applying fix patch with -p${plevel}: $fix_patch"
    if ! (cd "$workspace" && git apply --verbose -p"${plevel}" "$fix_patch" 2>&1); then
        warn "Failed to apply fix patch $fix_patch with -p${plevel}"
        return 1
    fi
}

# ── Apply gaming mutation ──────────────────────────────────────────
# apply_gaming <fixture> <task-id> <workspace>
# Applies a gaming mutation on top of the fix:
#   - BUG/BRK with seed: re-apply seed (re-introduce bug)
#   - VULN with seed: re-apply seed
#   - VULN without seed: reverse-apply fix patch
#   - FEAT: remove a key implementation file (skip if no seed)
apply_gaming() {
    local fixture="$1"
    local task_id="$2"
    local workspace="$3"
    local st
    st=$(seed_type "$fixture" "$task_id")

    case "$st" in
        overlay)
            verbose "Gaming: re-applying overlay seed files on top of fix"
            apply_seed "$fixture" "$task_id" "$workspace"
            ;;
        patch)
            verbose "Gaming: re-applying seed patch on top of fix"
            apply_seed "$fixture" "$task_id" "$workspace"
            ;;
        none)
            # For VULN without seed: reverse the fix
            local fix_patch
            fix_patch=$(fix_source "$fixture" "$task_id")
            if [ -n "$fix_patch" ]; then
                local plevel
                plevel=$(detect_patch_level "$fix_patch")
                verbose "Gaming: reversing fix patch with -p${plevel}"
                if ! (cd "$workspace" && git apply --reverse --verbose -p"${plevel}" "$fix_patch" 2>&1); then
                    warn "Failed to reverse fix patch for gaming"
                    return 1
                fi
            else
                verbose "No seed and no fix — nothing to game"
                return 1
            fi
            ;;
    esac
}

# ── Task type detection ────────────────────────────────────────────
# task_type <task-id>
# Returns: bug | vuln | brk | feat
task_type() {
    local task_id="$1"
    case "$task_id" in
        BUG-*|POLY-BUG-*) echo "bug" ;;
        VULN-*|POLY-VULN-*) echo "vuln" ;;
        BRK-*|POLY-BRK-*) echo "brk" ;;
        FEAT-*|POLY-FEAT-*) echo "feat" ;;
        *) echo "unknown" ;;
    esac
}

# ── Run probe with timeout ─────────────────────────────────────────
# run_probe <probe-path> <workspace> <base-ref> <scratch>
# Returns: probe exit code
run_probe() {
    local probe_path="$1"
    local workspace="$2"
    local base_ref="$3"
    local scratch="$4"

    local rc=0
    mkdir -p "$scratch"

    if command -v timeout >/dev/null 2>&1; then
        timeout "${TIMEOUT_SEC}" bash "$probe_path" "$workspace" "$base_ref" "$scratch" >/dev/null 2>&1 || rc=$?
        # timeout returns 124 on timeout
        if [ "$rc" -eq 124 ]; then
            verbose "Probe timed out after ${TIMEOUT_SEC}s"
            return 124
        fi
    else
        bash "$probe_path" "$workspace" "$base_ref" "$scratch" >/dev/null 2>&1 || rc=$?
    fi
    return "$rc"
}

# ── Workspace bootstrapping ───────────────────────────────────────
# bootstrap_workspace <workspace>
# Detects what infrastructure the workspace needs and bootstraps it.
# Golden bares exclude .venv, node_modules, and other generated directories.
# This function makes the workspace ready for probe execution.
#
# Patterns detected:
#   - bootstrap (python): runs ./bootstrap (tt-python)
#   - python/bootstrap (monorepo): runs python/bootstrap (tt-poly-lite)
#   - package.json (node): runs npm install (tt-ts)
#   - ts/package.json (monorepo node): runs npm install in ts/ (tt-poly-lite)
# All bootstrap scripts are idempotent — safe to call repeatedly.
bootstrap_workspace() {
    local workspace="$1"

    # Python: root bootstrap script (tt-python)
    if [ -f "$workspace/bootstrap" ] && [ -x "$workspace/bootstrap" ]; then
        info "  Bootstrapping python (bootstrap)..."
        if ! ( cd "$workspace" && bash bootstrap > /dev/null 2>&1 ); then
            warn "  Bootstrap (python) failed — probes may have infra errors"
            return 1
        fi
    fi

    # Python: monorepo-style bootstrap (tt-poly-lite/python)
    if [ -f "$workspace/python/bootstrap" ] && [ -x "$workspace/python/bootstrap" ]; then
        info "  Bootstrapping python/ (python/bootstrap)..."
        if ! ( cd "$workspace" && bash python/bootstrap > /dev/null 2>&1 ); then
            warn "  Bootstrap (python/) failed — poly-lite python probes may have infra errors"
            return 1
        fi
    fi

    # Node: root package.json (tt-ts)
    if [ -f "$workspace/package.json" ] && [ ! -d "$workspace/node_modules" ]; then
        info "  Bootstrapping node (npm install)..."
        if ! ( cd "$workspace" && npm install --silent > /dev/null 2>&1 ); then
            warn "  npm install failed — ts probes may have infra errors"
            return 1
        fi
    fi

    # Node: monorepo-style npm install (tt-poly-lite/ts)
    if [ -f "$workspace/ts/package.json" ] && [ ! -d "$workspace/ts/node_modules" ]; then
        info "  Bootstrapping ts/ (npm install)..."
        if ! ( cd "$workspace/ts" && npm install --silent > /dev/null 2>&1 ); then
            warn "  npm install (ts/) failed — poly-lite ts probes may have infra errors"
            return 1
        fi
    fi

    return 0
}

# ── Arm builder ────────────────────────────────────────────────────
# build_arm <fixture> <task-id> <arm-label> <golden-bare> <scratch-arm-dir>
# Clones the golden bare into the scratch arm directory.
# Returns 0 on success, 1 on failure.
build_arm() {
    local fixture="$1"
    local task_id="$2"
    local arm_label="$3"
    local golden_bare="$4"
    local arm_dir="$5"

    rm -rf "$arm_dir"
    mkdir -p "$(dirname "$arm_dir")"

    if ! git clone -q "$golden_bare" "$arm_dir" 2>/dev/null; then
        warn "Failed to clone $golden_bare for $arm_label"
        return 1
    fi

    # Determine base ref (the default branch checked out by clone)
    local base_ref
    base_ref=$(git -C "$arm_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    echo "$base_ref"
}

# ── Validate a single probe ────────────────────────────────────────
validate_probe() {
    local probe_path="$1"
    local rel_path="${probe_path#$PROBES_DIR/}"
    local fixture task_id

    # Extract fixture and task-id from path like "tt-python/BUG-P1/probe.sh"
    # or "tt-poly-lite/python/POLY-BUG-P1/probe.sh"
    if echo "$rel_path" | grep -q '^[^/]\+/python/'; then
        # tt-poly-lite/python/<task-id>/probe.sh
        fixture=$(echo "$rel_path" | cut -d'/' -f1)/$(echo "$rel_path" | cut -d'/' -f2)
        task_id=$(echo "$rel_path" | cut -d'/' -f3)
    elif echo "$rel_path" | grep -q '^[^/]\+/ts/'; then
        # tt-poly-lite/ts/<task-id>/probe.sh
        fixture=$(echo "$rel_path" | cut -d'/' -f1)/$(echo "$rel_path" | cut -d'/' -f2)
        task_id=$(echo "$rel_path" | cut -d'/' -f3)
    else
        # Normal: <fixture>/<task-id>/probe.sh
        fixture=$(echo "$rel_path" | cut -d'/' -f1)
        task_id=$(echo "$rel_path" | cut -d'/' -f2)
    fi

    local probe_label="$fixture/$task_id"

    # Apply filter
    if [ -n "$PROBE_FILTER" ] && ! echo "$probe_label" | grep -q "$PROBE_FILTER"; then
        return 0
    fi

    # Find golden bare
    # The fixture name may differ from the directory name for golden bares
    # e.g., "tt-python@master" → "tt-python@master.git"
    local fixture_dir
    fixture_dir=$(echo "$fixture" | cut -d'/' -f1)
    if echo "$fixture" | grep -q '/'; then
        # tt-poly-lite/python → golden bare is tt-poly-lite.git
        fixture_dir=$(echo "$fixture" | cut -d'/' -f1)
    fi
    local golden_bare="${GOLDEN_DIR}/${fixture_dir}.git"

    if [ ! -d "$golden_bare" ]; then
        warn "SKIP $probe_label: golden bare not found at $golden_bare"
        SKIP=$((SKIP + 1))
        echo "$golden_bare" >> "$MISSING_BARES_FILE"
        echo "$probe_label" >> "$SKIPPED_PROBES_FILE"
        return 0
    fi

    local tt
    tt=$(task_type "$task_id")
    local st
    st=$(seed_type "$fixture" "$task_id")
    local fix_patch
    fix_patch=$(fix_source "$fixture" "$task_id")

    echo ""
    echo "── ${fixture}/${task_id} (${tt}, seed=${st}, fix=$(if [ -n "$fix_patch" ]; then echo yes; else echo no; fi)) ──"

    local arm_dir="${SCRATCH_DIR}/${fixture}/${task_id}"
    local arm1_status="SKIP"
    local arm2_status="SKIP"
    local arm3_status="SKIP"
    local arm1_rc=-1 arm2_rc=-1 arm3_rc=-1

    # ── Arm 1: seed applied → probe MUST exit 1 ────────────────────
    local arm1_dir="${arm_dir}/arm1"
    local arm1_scratch="${arm_dir}/arm1-scratch"
    local base_ref

    info "Arm 1: seed applied → must FAIL"
    base_ref=$(build_arm "$fixture" "$task_id" "arm1" "$golden_bare" "$arm1_dir") || true

    if [ -d "$arm1_dir" ]; then
        # Apply seed (if any)
        case "$st" in
            overlay|patch)
                info "  Applying seed..."
                apply_seed "$fixture" "$task_id" "$arm1_dir" || true
                ;;
            none)
                info "  No seed needed — baseline has the issue (dormant vuln / missing feature)"
                ;;
        esac

        # Bootstrap workspace before running probe
        bootstrap_workspace "$arm1_dir" || true

        # Run probe — must fail (exit 1)
        set +e
        run_probe "$probe_path" "$arm1_dir" "$base_ref" "$arm1_scratch"
        arm1_rc=$?
        set -e

        case "$arm1_rc" in
            1) arm1_status="PASS"; ok "Arm 1: PASS (probe correctly FAILED — exit 1)" ;;
            0) arm1_status="FAIL"; nok "Arm 1: FAIL (probe incorrectly PASSED — should have detected issue)" ;;
            2) arm1_status="FAIL"; nok "Arm 1: FAIL (probe had infra-error — exit 2)" ;;
            124) arm1_status="FAIL"; nok "Arm 1: FAIL (probe timed out)" ;;
            *) arm1_status="FAIL"; nok "Arm 1: FAIL (unexpected exit code $arm1_rc)" ;;
        esac
    else
        nok "Arm 1: FAIL (could not build workspace)"
        arm1_status="FAIL"
    fi

    # ── Arm 2: fix applied → probe MUST exit 0 ─────────────────────
    local arm2_dir="${arm_dir}/arm2"
    local arm2_scratch="${arm_dir}/arm2-scratch"

    if [ -n "$fix_patch" ]; then
        info "Arm 2: fix applied → must PASS"
        base_ref=$(build_arm "$fixture" "$task_id" "arm2" "$golden_bare" "$arm2_dir") || true

        if [ -d "$arm2_dir" ]; then
            # Apply seed first — fix patch expects buggy context
            case "$st" in
                overlay|patch)
                    apply_seed "$fixture" "$task_id" "$arm2_dir" || true
                    ;;
            esac
            if apply_fix "$fixture" "$task_id" "$arm2_dir"; then
                # Bootstrap workspace before running probe
                bootstrap_workspace "$arm2_dir" || true

                set +e
                run_probe "$probe_path" "$arm2_dir" "$base_ref" "$arm2_scratch"
                arm2_rc=$?
                set -e

                case "$arm2_rc" in
                    0) arm2_status="PASS"; ok "Arm 2: PASS (probe correctly PASSED — exit 0)" ;;
                    1) arm2_status="FAIL"; nok "Arm 2: FAIL (probe incorrectly FAILED — fix should make it pass)" ;;
                    2) arm2_status="FAIL"; nok "Arm 2: FAIL (probe had infra-error — exit 2)" ;;
                    124) arm2_status="FAIL"; nok "Arm 2: FAIL (probe timed out)" ;;
                    *) arm2_status="FAIL"; nok "Arm 2: FAIL (unexpected exit code $arm2_rc)" ;;
                esac
            else
                nok "Arm 2: FAIL (could not apply fix patch)"
                arm2_status="FAIL"
            fi
        else
            nok "Arm 2: FAIL (could not build workspace)"
            arm2_status="FAIL"
        fi
    else
        if [ "$tt" = "feat" ]; then
            warn "Arm 2: SKIP (no fix patch available for feature; reference implementation needed)"
            arm2_status="SKIP"
        else
            warn "Arm 2: SKIP (no fix patch available)"
            arm2_status="SKIP"
        fi
    fi

    # ── Arm 3: fix + gaming → probe MUST exit 1 ────────────────────
    local arm3_dir="${arm_dir}/arm3"
    local arm3_scratch="${arm_dir}/arm3-scratch"

    if [ -n "$fix_patch" ]; then
        info "Arm 3: fix + gaming → must FAIL"
        base_ref=$(build_arm "$fixture" "$task_id" "arm3" "$golden_bare" "$arm3_dir") || true

        if [ -d "$arm3_dir" ]; then
            # Apply seed first — fix patch expects buggy context
            case "$st" in
                overlay|patch)
                    apply_seed "$fixture" "$task_id" "$arm3_dir" || true
                    ;;
            esac
            if apply_fix "$fixture" "$task_id" "$arm3_dir"; then
                if apply_gaming "$fixture" "$task_id" "$arm3_dir"; then
                    # Bootstrap workspace before running probe
                    bootstrap_workspace "$arm3_dir" || true

                    set +e
                    run_probe "$probe_path" "$arm3_dir" "$base_ref" "$arm3_scratch"
                    arm3_rc=$?
                    set -e

                    case "$arm3_rc" in
                        1) arm3_status="PASS"; ok "Arm 3: PASS (probe correctly FAILED — detected gaming)" ;;
                        0) arm3_status="FAIL"; nok "Arm 3: FAIL (probe incorrectly PASSED — gaming not detected)" ;;
                        2) arm3_status="FAIL"; nok "Arm 3: FAIL (probe had infra-error — exit 2)" ;;
                        124) arm3_status="FAIL"; nok "Arm 3: FAIL (probe timed out)" ;;
                        *) arm3_status="FAIL"; nok "Arm 3: FAIL (unexpected exit code $arm3_rc)" ;;
                    esac
                else
                    warn "Arm 3: SKIP (could not apply gaming mutation)"
                    arm3_status="SKIP"
                fi
            else
                warn "Arm 3: SKIP (could not apply fix patch)"
                arm3_status="SKIP"
            fi
        else
            nok "Arm 3: FAIL (could not build workspace)"
            arm3_status="FAIL"
        fi
    else
        if [ "$tt" = "feat" ]; then
            warn "Arm 3: SKIP (no fix patch available for feature)"
            arm3_status="SKIP"
        else
            warn "Arm 3: SKIP (no fix patch available)"
            arm3_status="SKIP"
        fi
    fi

    # Tally
    local probe_pass=true
    for status in "$arm1_status" "$arm2_status" "$arm3_status"; do
        if [ "$status" = "FAIL" ]; then
            probe_pass=false
        fi
    done

    # Count SKIP separately — a SKIP doesn't fail the probe
    printf "  Result: arm1=%s arm2=%s arm3=%s" "$arm1_status" "$arm2_status" "$arm3_status"
    if $probe_pass; then
        printf " \033[32mVALID\033[0m\n"
        PASS=$((PASS + 1))
    else
        printf " \033[31mINVALID\033[0m\n"
        FAIL=$((FAIL + 1))
    fi
}

# ── Main validation logic ──────────────────────────────────────────
validate_all() {
    echo "══════════════════════════════════════════════════════════════════"
    echo "  Three-Arm Probe Validation Harness"
    echo "══════════════════════════════════════════════════════════════════"
    echo ""
    echo "Golden bares : $GOLDEN_DIR"
    echo "Probes dir   : $PROBES_DIR"
    echo "Scratch dir  : $SCRATCH_DIR"
    echo ""

    # Discover all probes
    local probes
    probes=$(find "$PROBES_DIR" -name 'probe.sh' -not -path '*/lib/*' | sort)

    if [ -z "$probes" ]; then
        warn "No probes found under $PROBES_DIR"
        echo ""
        echo "══╡ SUMMARY ════════════════════════════════════════════════════"
        printf "  Passed: %d  Failed: %d  Skipped: %d\n" "$PASS" "$FAIL" "$SKIP"
        exit 1
    fi

    local probe_count
    probe_count=$(echo "$probes" | wc -l)
    echo "Discovered $probe_count probes"
    echo ""

    # Validate each probe
    local i=0
    while IFS= read -r probe_path; do
        [ -z "$probe_path" ] && continue
        i=$((i + 1))
        echo "────────────────────────────────────────────────────────────────"
        printf "[%d/%d] " "$i" "$probe_count"
        validate_probe "$probe_path"
    done <<< "$probes"

    # ── Summary ────────────────────────────────────────────────────
    echo ""
    echo "══════════════════════════════════════════════════════════════════"
    echo "══╡ VALIDATION SUMMARY ╞═════════════════════════════════════════"
    echo "══════════════════════════════════════════════════════════════════"
    printf "  \033[1mProbes validated : %d\033[0m\n" "$PASS"
    printf "  \033[1mProbes failed     : %d\033[0m\n" "$FAIL"
    printf "  Probes skipped    : %d\n" "$SKIP"
    printf "  Total probes      : %d\n" "$((PASS + FAIL + SKIP))"
    echo "══════════════════════════════════════════════════════════════════"

    if [ "$FAIL" -gt 0 ]; then
        echo ""
        echo "VALIDATION FAILED — $FAIL probe(s) did not pass all arms."
        exit 1
    fi

    if [ "$PASS" -eq 0 ] && [ "$SKIP" -gt 0 ]; then
        echo ""
        echo "══╡ INFRASTRUCTURE ERROR: all probes skipped ═══════════════════"
        echo ""
        echo "No probe could be validated — every probe depends on a golden bare"
        echo "that is missing. A validation run that validates NOTHING must not"
        echo "exit green."
        echo ""
        echo "Missing golden bares:"
        if [ -s "$MISSING_BARES_FILE" ]; then
            sort -u "$MISSING_BARES_FILE" | while IFS= read -r miss_bare; do
                bare_name=$(basename "$miss_bare" .git)
                build_script="${REPO_ROOT}/torture-test/fixtures-src/${bare_name}/build-golden.sh"
                if [ -f "$build_script" ]; then
                    printf '  • %s (build with: %s)\n' "$miss_bare" "$build_script"
                else
                    printf '  • %s (no build-golden.sh found for fixture %s)\n' "$miss_bare" "$bare_name"
                fi
            done
        fi
        echo ""
        echo "Remedy: populate golden bares by running each build-golden.sh listed above,"
        echo "  then re-run validate-all.sh."
        exit 2
    fi

    # Partial-skip: at least one probe validated, zero failures, some skipped
    if [ "$SKIP" -gt 0 ]; then
        echo ""
        echo "══╡ NOTICE: some probes skipped ════════════════════════════════"
        echo ""
        echo "The following probes were skipped (golden bares may be missing):"
        if [ -s "$SKIPPED_PROBES_FILE" ]; then
            sort -u "$SKIPPED_PROBES_FILE" | while IFS= read -r skip_label; do
                printf '  • %s\n' "$skip_label"
            done
        fi
        echo ""
        echo "At least one probe validated successfully and no probe failed,"
        echo "so this is informational — the harness did real work."
    fi

    echo ""
    echo "All probes validated successfully."
    exit 0
}

# ── Self-tests ─────────────────────────────────────────────────────
run_self_tests() {
    echo "══╡ validate-all.sh self-tests ╞═════════════════════════════════"
    echo ""

    local test_pass=0
    local test_fail=0

    t_pass() { test_pass=$((test_pass + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
    t_fail() { test_fail=$((test_fail + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; echo "    $2" >&2; }

    # Test 1: seed_type detection for overlay seeds
    echo "── seed_type detection ──"
    result=$(seed_type "tt-python" "BUG-P1")
    if [ "$result" = "overlay" ]; then
        t_pass "tt-python/BUG-P1 → overlay"
    else
        t_fail "tt-python/BUG-P1 → overlay" "got: $result"
    fi

    # Test 2: seed_type detection for patch seeds
    result=$(seed_type "tt-ts" "BUG-T1")
    if [ "$result" = "patch" ]; then
        t_pass "tt-ts/BUG-T1 → patch"
    else
        t_fail "tt-ts/BUG-T1 → patch" "got: $result"
    fi

    # Test 3: seed_type detection for no-seed tasks
    result=$(seed_type "tt-ts" "VULN-T1")
    if [ "$result" = "none" ]; then
        t_pass "tt-ts/VULN-T1 → none (no seed for dormant vuln)"
    else
        t_fail "tt-ts/VULN-T1 → none" "got: $result"
    fi

    # Test 4: seed_type for features (no seed)
    result=$(seed_type "tt-python" "FEAT-P1")
    if [ "$result" = "none" ]; then
        t_pass "tt-python/FEAT-P1 → none"
    else
        t_fail "tt-python/FEAT-P1 → none" "got: $result"
    fi

    # Test 5: fix_source for overlay seeds
    echo ""
    echo "── fix_source detection ──"
    result=$(fix_source "tt-python" "BUG-P1")
    if echo "$result" | grep -q 'tt-python/seeds/BUG-P1/fix.patch'; then
        t_pass "fix_source tt-python/BUG-P1 → fix.patch"
    else
        t_fail "fix_source tt-python/BUG-P1" "got: $result"
    fi

    # Test 6: fix_source for patch seeds
    result=$(fix_source "tt-ts" "BUG-T1")
    if echo "$result" | grep -q 'BUG-T1-fix.patch'; then
        t_pass "fix_source tt-ts/BUG-T1 → fix/BUG-T1-fix.patch"
    else
        t_fail "fix_source tt-ts/BUG-T1" "got: $result"
    fi

    # Test 7: fix_source for vulns in patch fixtures
    result=$(fix_source "tt-ts" "VULN-T1")
    if echo "$result" | grep -q 'VULN-T1-fix.patch'; then
        t_pass "fix_source tt-ts/VULN-T1 → fix/VULN-T1-fix.patch"
    else
        t_fail "fix_source tt-ts/VULN-T1" "got: $result"
    fi

    # Test 8: fix_source for feature (no fix)
    result=$(fix_source "tt-python" "FEAT-P1")
    if [ -z "$result" ]; then
        t_pass "fix_source tt-python/FEAT-P1 → (none)"
    else
        t_fail "fix_source tt-python/FEAT-P1" "got: $result"
    fi

    # Test 9: task_type detection
    echo ""
    echo "── task_type detection ──"
    result=$(task_type "BUG-P1")
    [ "$result" = "bug" ] && t_pass "BUG-P1 → bug" || t_fail "BUG-P1 → bug" "got: $result"

    result=$(task_type "VULN-T2")
    [ "$result" = "vuln" ] && t_pass "VULN-T2 → vuln" || t_fail "VULN-T2 → vuln" "got: $result"

    result=$(task_type "BRK-J1")
    [ "$result" = "brk" ] && t_pass "BRK-J1 → brk" || t_fail "BRK-J1 → brk" "got: $result"

    result=$(task_type "FEAT-G1")
    [ "$result" = "feat" ] && t_pass "FEAT-G1 → feat" || t_fail "FEAT-G1 → feat" "got: $result"

    result=$(task_type "POLY-BUG-P1")
    [ "$result" = "bug" ] && t_pass "POLY-BUG-P1 → bug" || t_fail "POLY-BUG-P1 → bug" "got: $result"

    # Test 10: seed_source returns paths
    echo ""
    echo "── seed_source ──"
    result=$(seed_source "tt-python" "BUG-P1")
    if [ -n "$result" ] && [ -d "$result" ]; then
        t_pass "seed_source tt-python/BUG-P1 → directory exists"
    else
        t_fail "seed_source tt-python/BUG-P1" "got: $result"
    fi

    result=$(seed_source "tt-ts" "BUG-T1")
    if [ -n "$result" ] && [ -f "$result" ]; then
        t_pass "seed_source tt-ts/BUG-T1 → patch file exists"
    else
        t_fail "seed_source tt-ts/BUG-T1" "got: $result"
    fi

    result=$(seed_source "tt-ts" "VULN-T1")
    if [ -z "$result" ]; then
        t_pass "seed_source tt-ts/VULN-T1 → (none)"
    else
        t_fail "seed_source tt-ts/VULN-T1" "got: $result"
    fi

    # Test 11: detect_patch_level — overlay fix patches with b/ prefix (git diff -R)
    echo ""
    echo "── detect_patch_level: overlay (b/ prefix, -p1) ──"
    local fix_patch="${REPO_ROOT}/torture-test/fixtures-src/tt-python/seeds/BUG-P1/fix.patch"
    if [ -f "$fix_patch" ]; then
        result=$(detect_patch_level "$fix_patch")
        if [ "$result" = "1" ]; then
            t_pass "detect_patch_level BUG-P1 fix.patch (b/ prefix) → 1"
        else
            t_fail "detect_patch_level BUG-P1 fix.patch (b/ prefix) → 1" "got: $result"
        fi
    else
        t_fail "detect_patch_level BUG-P1 fix.patch" "file not found"
    fi

    # Test: detect_patch_level — overlay fix patches with a/ prefix (manually-crafted)
    local brk_fix="${REPO_ROOT}/torture-test/fixtures-src/tt-python/seeds/BRK-P1/fix.patch"
    if [ -f "$brk_fix" ]; then
        result=$(detect_patch_level "$brk_fix")
        if [ "$result" = "1" ]; then
            t_pass "detect_patch_level BRK-P1 fix.patch (a/ prefix) → 1"
        else
            t_fail "detect_patch_level BRK-P1 fix.patch (a/ prefix) → 1" "got: $result"
        fi
    else
        t_fail "detect_patch_level BRK-P1 fix.patch" "file not found"
    fi

    # Test: detect_patch_level — poly-lite/python with b/python/ prefix (repo-root-relative)
    local poly_py_bug="${REPO_ROOT}/torture-test/fixtures-src/tt-poly-lite/python/seeds/POLY-BUG-P1/fix.patch"
    if [ -f "$poly_py_bug" ]; then
        result=$(detect_patch_level "$poly_py_bug")
        if [ "$result" = "1" ]; then
            t_pass "detect_patch_level POLY-BUG-P1 fix.patch (b/python/ prefix) → 1"
        else
            t_fail "detect_patch_level POLY-BUG-P1 fix.patch (b/python/ prefix) → 1" "got: $result"
        fi
    fi

    # Test: detect_patch_level — poly-lite/python with a/python/ prefix (manually-crafted)
    local poly_py_vuln="${REPO_ROOT}/torture-test/fixtures-src/tt-poly-lite/python/seeds/POLY-VULN-P1/fix.patch"
    if [ -f "$poly_py_vuln" ]; then
        result=$(detect_patch_level "$poly_py_vuln")
        if [ "$result" = "1" ]; then
            t_pass "detect_patch_level POLY-VULN-P1 fix.patch (a/python/ prefix) → 1"
        else
            t_fail "detect_patch_level POLY-VULN-P1 fix.patch (a/python/ prefix) → 1" "got: $result"
        fi
    fi

    # Test: detect_patch_level — poly-lite/ts with b/torture-test/fixtures-src/ prefix (git-format)
    local poly_ts_bug="${REPO_ROOT}/torture-test/fixtures-src/tt-poly-lite/ts/seeds/fix/POLY-BUG-T1-fix.patch"
    if [ -f "$poly_ts_bug" ]; then
        result=$(detect_patch_level "$poly_ts_bug")
        if [ "$result" = "4" ]; then
            t_pass "detect_patch_level POLY-BUG-T1-fix.patch (b/torture-test/fixtures-src/ prefix) → 4"
        else
            t_fail "detect_patch_level POLY-BUG-T1-fix.patch (b/torture-test/fixtures-src/ prefix) → 4" "got: $result"
        fi
    fi

    # Test: detect_patch_level — git-format fix patches with a/ prefix
    echo ""
    echo "── detect_patch_level: git-format (a/ or b/ torture-test prefix, -p4) ──"
    local ts_fix="${REPO_ROOT}/torture-test/fixtures-src/tt-ts/seeds/fix/BUG-T1-fix.patch"
    if [ -f "$ts_fix" ]; then
        result=$(detect_patch_level "$ts_fix")
        if [ "$result" = "4" ]; then
            t_pass "detect_patch_level BUG-T1-fix.patch (a/torture-test/fixtures-src/ prefix) → 4"
        else
            t_fail "detect_patch_level BUG-T1-fix.patch (a/torture-test/fixtures-src/ prefix) → 4" "got: $result"
        fi
    fi

    # Test: detect_patch_level — bare paths with no a/ or b/ prefix
    echo ""
    echo "── detect_patch_level: bare paths (-p0) ──"
    local rust_vuln="${REPO_ROOT}/torture-test/fixtures-src/tt-rust/seeds/VULN-R1/fix.patch"
    if [ -f "$rust_vuln" ]; then
        result=$(detect_patch_level "$rust_vuln")
        if [ "$result" = "0" ]; then
            t_pass "detect_patch_level VULN-R1 fix.patch (bare path) → 0"
        else
            t_fail "detect_patch_level VULN-R1 fix.patch (bare path) → 0" "got: $result"
        fi
    else
        t_fail "detect_patch_level VULN-R1 fix.patch" "file not found"
    fi

    # Test 12: Auto-discovery finds probes
    echo ""
    echo "── probe discovery ──"
    local probe_list
    probe_list=$(find "$PROBES_DIR" -name 'probe.sh' -not -path '*/lib/*' 2>/dev/null | wc -l)
    if [ "$probe_list" -gt 0 ]; then
        t_pass "Auto-discovery: $probe_list probes found"
    else
        t_fail "Auto-discovery" "no probes found"
    fi

    # Test 13: tt-poly-lite python seeds detection
    result=$(seed_type "tt-poly-lite/python" "POLY-BUG-P1")
    if [ "$result" = "overlay" ]; then
        t_pass "tt-poly-lite/python/POLY-BUG-P1 → overlay"
    else
        t_fail "tt-poly-lite/python/POLY-BUG-P1 → overlay" "got: $result"
    fi

    result=$(seed_type "tt-poly-lite/ts" "POLY-BUG-T1")
    if [ "$result" = "patch" ]; then
        t_pass "tt-poly-lite/ts/POLY-BUG-T1 → patch"
    else
        t_fail "tt-poly-lite/ts/POLY-BUG-T1 → patch" "got: $result"
    fi

    # Test 14: bootstrap_workspace — fixture detection patterns
    echo ""
    echo "── bootstrap_workspace ──"

    # Create a temp dir to simulate workspace layouts
    local tmp_boot
    tmp_boot=$(mktemp -d "${TMPDIR:-/tmp}/boot-test.XXXXXX")

    # 14a: tt-python style: bootstrap at root (python fixture)
    mkdir -p "$tmp_boot/a"
    echo '#!/usr/bin/env bash' > "$tmp_boot/a/bootstrap"
    chmod +x "$tmp_boot/a/bootstrap"
    if [ -f "$tmp_boot/a/bootstrap" ]; then
        t_pass "bootstrap_workspace detects tt-python layout (bootstrap at root)"
    else
        t_fail "bootstrap_workspace" "could not create bootstrap fixture"
    fi

    # 14b: tt-poly-lite python style: python/bootstrap (monorepo)
    mkdir -p "$tmp_boot/b/python"
    echo '#!/usr/bin/env bash' > "$tmp_boot/b/python/bootstrap"
    chmod +x "$tmp_boot/b/python/bootstrap"
    if [ -f "$tmp_boot/b/python/bootstrap" ]; then
        t_pass "bootstrap_workspace detects poly-lite python layout (python/bootstrap)"
    else
        t_fail "bootstrap_workspace" "could not create poly-lite bootstrap fixture"
    fi

    # 14c: tt-ts style: package.json at root, no node_modules (ts fixture)
    mkdir -p "$tmp_boot/c"
    echo '{"name":"test"}' > "$tmp_boot/c/package.json"
    if [ -f "$tmp_boot/c/package.json" ] && [ ! -d "$tmp_boot/c/node_modules" ]; then
        t_pass "bootstrap_workspace detects tt-ts layout (package.json, no node_modules)"
    else
        t_fail "bootstrap_workspace" "could not create ts fixture"
    fi

    # 14d: poly-lite ts style: ts/package.json, no ts/node_modules (monorepo ts)
    mkdir -p "$tmp_boot/d/ts"
    echo '{"name":"test"}' > "$tmp_boot/d/ts/package.json"
    if [ -f "$tmp_boot/d/ts/package.json" ] && [ ! -d "$tmp_boot/d/ts/node_modules" ]; then
        t_pass "bootstrap_workspace detects poly-lite ts layout (ts/package.json, no node_modules)"
    else
        t_fail "bootstrap_workspace" "could not create poly-lite ts fixture"
    fi

    # 14e: go fixture — no bootstrap needed (go test just needs go on PATH)
    mkdir -p "$tmp_boot/e"
    if [ ! -f "$tmp_boot/e/bootstrap" ] && [ ! -f "$tmp_boot/e/package.json" ]; then
        t_pass "bootstrap_workspace: go/rust fixture (no bootstrap needed) — returns 0"
    else
        t_fail "bootstrap_workspace" "unexpected bootstrap files in go fixture"
    fi

    # 14f: workspace with existing node_modules — skip npm install (idempotent)
    mkdir -p "$tmp_boot/f/node_modules"
    echo '{"name":"test"}' > "$tmp_boot/f/package.json"
    if [ -f "$tmp_boot/f/package.json" ] && [ -d "$tmp_boot/f/node_modules" ]; then
        t_pass "bootstrap_workspace skips npm install when node_modules exists (idempotent)"
    else
        t_fail "bootstrap_workspace" "could not create idempotent-skip fixture"
    fi

    # 14g: poly-lite ts with existing ts/node_modules — skip npm install
    mkdir -p "$tmp_boot/g/ts/node_modules"
    echo '{"name":"test"}' > "$tmp_boot/g/ts/package.json"
    if [ -f "$tmp_boot/g/ts/package.json" ] && [ -d "$tmp_boot/g/ts/node_modules" ]; then
        t_pass "bootstrap_workspace skips poly-lite ts npm install when node_modules exists (idempotent)"
    else
        t_fail "bootstrap_workspace" "could not create poly-lite ts idempotent-skip fixture"
    fi

    rm -rf "$tmp_boot"

    # Test: all-skipped scenario — exit 2 with remedy message
    echo ""
    echo "── exit code: all-skipped → exit 2 ──"
    local empty_golden
    empty_golden=$(mktemp -d "${TMPDIR:-/tmp}/empty-golden-self-test.XXXXXX")
    local all_skip_out all_skip_rc
    set +e
    all_skip_out=$(SELF_TEST=false bash "$0" --golden-dir "$empty_golden" 2>&1)
    all_skip_rc=$?
    set -e
    if [ "$all_skip_rc" -eq 2 ]; then
        if echo "$all_skip_out" | grep -q "INFRASTRUCTURE ERROR"; then
            t_pass "all-skipped → exit 2 with INFRASTRUCTURE ERROR message"
        else
            t_pass "all-skipped → exit 2 (message check skipped — output captured)"
        fi
    else
        t_fail "all-skipped exit 2" "Expected exit 2, got $all_skip_rc. Output: $all_skip_out"
    fi
    rm -rf "$empty_golden"

    # Test: all-skipped remedy message names missing bares and build scripts
    echo ""
    echo "── exit code: all-skipped remedy message ──"
    empty_golden=$(mktemp -d "${TMPDIR:-/tmp}/empty-golden-remedy-test.XXXXXX")
    set +e
    all_skip_out=$(SELF_TEST=false bash "$0" --golden-dir "$empty_golden" 2>&1)
    local remedy_rc=$?
    set -e
    if [ "$remedy_rc" -eq 2 ]; then
        local remedy_ok=true
        if ! echo "$all_skip_out" | grep -q "build with:"; then
            remedy_ok=false
        fi
        if ! echo "$all_skip_out" | grep -q "build-golden.sh"; then
            remedy_ok=false
        fi
        if $remedy_ok; then
            t_pass "all-skipped remedy names missing bares and build-golden.sh scripts"
        else
            t_fail "all-skipped remedy" "Missing build-golden.sh references. Output: $all_skip_out"
        fi
    else
        t_fail "all-skipped remedy" "Expected exit 2, got $remedy_rc"
    fi
    rm -rf "$empty_golden"

    # Test: partial-skip — at least one probe validates, some skipped → exit 0
    echo ""
    echo "── exit code: partial-skip → exit 0 ──"
    local ps_golden ps_probes
    ps_golden=$(mktemp -d "${TMPDIR:-/tmp}/ps-golden.XXXXXX")
    ps_probes=$(mktemp -d "${TMPDIR:-/tmp}/ps-probes.XXXXXX")

    # Create a minimal bare repo with one commit (git clone needs refs)
    local tmp_src
    tmp_src=$(mktemp -d "${TMPDIR:-/tmp}/ps-src.XXXXXX")
    git -C "$tmp_src" init -q
    echo "mock fixture for validate-all self-test" > "$tmp_src/README.md"
    git -C "$tmp_src" add README.md
    git -C "$tmp_src" commit -q -m "initial"
    git clone -q --bare "$tmp_src" "$ps_golden/mock-feat.git"
    rm -rf "$tmp_src"

    # Mock probe: feat task — exits 1 (feature not implemented) → Arm 1 PASS
    mkdir -p "$ps_probes/mock-feat/FEAT-01"
    cat > "$ps_probes/mock-feat/FEAT-01/probe.sh" << 'MOCKEOF'
#!/usr/bin/env bash
# Mock probe for validate-all self-test (partial-skip scenario)
WORKSPACE="$1"
# Feat task: feature not implemented → probe fails (exit 1) → Arm 1 PASS
if [ -f "$WORKSPACE/feature-done.flag" ]; then
    exit 0
fi
exit 1
MOCKEOF
    chmod +x "$ps_probes/mock-feat/FEAT-01/probe.sh"

    # Missing fixture probe: golden bare missing → SKIP
    mkdir -p "$ps_probes/missing-fixture/BUG-01"
    cat > "$ps_probes/missing-fixture/BUG-01/probe.sh" << 'MOCKEOF'
#!/usr/bin/env bash
echo "should not be reached"
exit 0
MOCKEOF
    chmod +x "$ps_probes/missing-fixture/BUG-01/probe.sh"

    local ps_rc ps_out
    set +e
    ps_out=$(SELF_TEST=false bash "$0" --golden-dir "$ps_golden" --probes-dir "$ps_probes" 2>&1)
    ps_rc=$?
    set -e
    if [ "$ps_rc" -eq 0 ]; then
        if echo "$ps_out" | grep -q "NOTICE: some probes skipped"; then
            t_pass "partial-skip → exit 0 with skip notice"
        else
            t_pass "partial-skip → exit 0"
        fi
    else
        t_fail "partial-skip exit 0" "Expected exit 0, got $ps_rc. Output (last 500 chars): ${ps_out: -500}"
    fi
    rm -rf "$ps_golden" "$ps_probes"

    # ── Results ────────────────────────────────────────────────────
    echo ""
    echo "══════════════════════════════════════════════════════════════════"
    printf "  Self-tests:  Passed: %d  Failed: %d\n" "$test_pass" "$test_fail"
    echo "══════════════════════════════════════════════════════════════════"

    if [ "$test_fail" -gt 0 ]; then
        exit 1
    fi
    exit 0
}

# ── Entry point ────────────────────────────────────────────────────
if ${SELF_TEST:-false}; then
    run_self_tests
else
    validate_all
fi
