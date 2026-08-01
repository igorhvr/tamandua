#!/usr/bin/env bash
# probe-common.sh — Shared utility library for held-out acceptance probes
#
# Source this at the top of every probe script:
#   source "$(dirname "$0")/../../lib/probe-common.sh"
#
# Contract (from 02-fixture-projects.md §probes):
#   probe.sh <workspace> <base-ref> <scratch-dir>
#   Exit codes: 0 = pass, 1 = fail, 2 = infra-error

set -euo pipefail

# ── Protocol: probe scripts set PROBE_ID before sourcing ──
# If the caller hasn't set PROBE_ID, derive it from the script's directory.
if [ -z "${PROBE_ID:-}" ]; then
    PROBE_ID="$(basename "$(dirname "$0")")"
fi

# ── Exit codes ──
readonly EXIT_PASS=0
readonly EXIT_FAIL=1
readonly EXIT_INFRA=2

# ── Verbose command execution ──
# vrun <cmd...> — run a command, echoing it to stderr first.
vrun() {
    printf '>>> %s\n' "$*" >&2
    "$@"
}

# ── Terminal functions ──
# fail <msg...> — print message to stderr and exit 1 (probe failure).
fail() {
    printf 'FAIL [%s]: %s\n' "${PROBE_ID:-unknown}" "$*" >&2
    exit $EXIT_FAIL
}

# pass_ <msg...> — print message to stderr and exit 0 (probe pass).
# Named pass_ to avoid colliding with potential system commands.
pass_() {
    printf 'PASS [%s]: %s\n' "${PROBE_ID:-unknown}" "$*" >&2
    exit $EXIT_PASS
}

# infra_error <msg...> — print message to stderr and exit 2 (infra error).
infra_error() {
    printf 'INFRA-ERROR [%s]: %s\n' "${PROBE_ID:-unknown}" "$*" >&2
    exit $EXIT_INFRA
}

# ── Assertions ──

# assert_grep <pattern> <file> [msg] — grep for pattern in file; fail if not found.
assert_grep() {
    local pattern="$1"
    local file="$2"
    local msg="${3:-expected pattern '$pattern' not found in $file}"
    if ! grep -q "$pattern" "$file"; then
        fail "$msg"
    fi
}

# assert_not_grep <pattern> <file> [msg] — grep for pattern in file; fail if found.
assert_not_grep() {
    local pattern="$1"
    local file="$2"
    local msg="${3:-forbidden pattern '$pattern' found in $file}"
    if grep -q "$pattern" "$file"; then
        fail "$msg"
    fi
}

# ── File checks ──

# check_file_exists <file> [msg] — fail if file doesn't exist.
check_file_exists() {
    local file="$1"
    local msg="${2:-required file '$file' does not exist}"
    if [ ! -f "$file" ]; then
        fail "$msg"
    fi
}

# check_dir_exists <dir> [msg] — fail if directory doesn't exist.
check_dir_exists() {
    local dir="$1"
    local msg="${2:-required directory '$dir' does not exist}"
    if [ ! -d "$dir" ]; then
        fail "$msg"
    fi
}

# ── Command output checks ──

# check_cmd_output <expected_pattern> <cmd...> — run command; fail if stdout doesn't contain pattern.
# The command is run inside the workspace.
check_cmd_output() {
    local pattern="$1"
    shift
    local output
    if ! output=$("$@" 2>&1); then
        fail "command '$*' failed with exit code $?: $output"
    fi
    if ! grep -q "$pattern" <<< "$output"; then
        fail "command '$*' output did not contain expected pattern '$pattern'. Output: $output"
    fi
}

# ── Regression test helpers for bug probes ──

# check_regression_test <workspace> <test_pattern> [msg]
# Asserts that a regression test matching <test_pattern> exists in the workspace.
# Greps for the pattern in all test files (*.test.*, test_*, etc.) under <workspace>.
check_regression_test() {
    local workspace="$1"
    local pattern="$2"
    local msg="${3:-no regression test matching '$pattern' found in $workspace}"
    # Search in common test file patterns
    local found
    found=$(find "$workspace" -type f \( \
        -name 'test_*.py' -o \
        -name '*_test.py' -o \
        -name '*.test.ts' -o \
        -name '*.test.js' -o \
        -name '*Test.java' -o \
        -name '*_test.go' -o \
        -name '*_test.rs' -o \
        -name '*.test.mjs' \
    \) -not -path '*/node_modules/*' -not -path '*/target/*' -not -path '*/__pycache__/*' \
      -not -path '*/.venv/*' -not -path '*/vendor/*' \
      -exec grep -l "$pattern" {} \; 2>/dev/null)
    if [ -z "$found" ]; then
        fail "$msg"
    fi
}

# ── seed overlay helpers ──

# apply_seed_overlay <seed_dir> <workspace>
# Copies seed overlay files from <seed_dir> into <workspace>.
# Overlay files are source-file copies; fix.patch is excluded.
apply_seed_overlay() {
    local seed_dir="$1"
    local workspace="$2"
    if [ ! -d "$seed_dir" ]; then
        infra_error "seed directory '$seed_dir' does not exist"
    fi
    for f in "$seed_dir"/*; do
        local bn
        bn=$(basename "$f")
        # Skip fix.patch and SEEDS.md — those are not overlays
        case "$bn" in
            fix.patch|SEEDS.md|.gitkeep) continue ;;
        esac
        local dest=$(find "$workspace" -type f -name "$bn" -not -path '*/node_modules/*' -not -path '*/target/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' 2>/dev/null | head -1)
        if [ -n "$dest" ]; then
            cp "$f" "$dest"
        else
            # If the file doesn't exist in the workspace yet, place it at the expected relative location
            # Try common source directories
            local placed=0
            for src_dir in "$workspace/src" "$workspace/lib" "$workspace"; do
                if [ -d "$src_dir" ]; then
                    cp "$f" "$src_dir/"
                    placed=1
                    break
                fi
            done
            if [ "$placed" -eq 0 ]; then
                cp "$f" "$workspace/"
            fi
        fi
    done
}

# apply_seed_patch <seed_dir> <workspace>
# Applies fix.patch from <seed_dir> onto <workspace> using git apply.
# This is the "known-good fix" — the opposite of applying the seed overlay.
apply_seed_patch() {
    local seed_dir="$1"
    local workspace="$2"
    local patch_file="$seed_dir/fix.patch"
    if [ ! -f "$patch_file" ]; then
        infra_error "fix.patch not found in '$seed_dir'"
    fi
    ( cd "$workspace" && git apply --verbose "$patch_file" ) || \
        infra_error "failed to apply fix.patch from '$seed_dir' to '$workspace'"
}

# revert_seed_patch <seed_dir> <workspace>
# Reverse-applies fix.patch to revert the known-good fix (restore buggy state).
revert_seed_patch() {
    local seed_dir="$1"
    local workspace="$2"
    local patch_file="$seed_dir/fix.patch"
    if [ ! -f "$patch_file" ]; then
        infra_error "fix.patch not found in '$seed_dir'"
    fi
    ( cd "$workspace" && git apply --reverse --verbose "$patch_file" ) || \
        infra_error "failed to reverse-apply fix.patch from '$seed_dir' to '$workspace'"
}

# ── Workspace helpers ──

# run_in_workspace <workspace> <cmd...> — run a command in the workspace directory.
run_in_workspace() {
    local workspace="$1"
    shift
    ( cd "$workspace" && "$@" )
}

# workspace_grep <workspace> <pattern> [pathspec]
# Grep for pattern in workspace, excluding noise directories.
workspace_grep() {
    local workspace="$1"
    local pattern="$2"
    local pathspec="${3:-.}"
    grep -r "$pattern" "$workspace/$pathspec" \
        --exclude-dir=node_modules \
        --exclude-dir=target \
        --exclude-dir=__pycache__ \
        --exclude-dir=.venv \
        --exclude-dir=vendor \
        --exclude-dir=.git \
        2>/dev/null || true
}

# ── Language-specific TEST_CMD runners ──

# run_python_tests <workspace> [pytest_args...]
# Runs pytest from the workspace's venv.
run_python_tests() {
    local workspace="$1"
    shift
    if [ -x "$workspace/.venv/bin/pytest" ]; then
        run_in_workspace "$workspace" .venv/bin/pytest -q "$@"
    elif [ -x "$workspace/.venv/bin/python" ]; then
        run_in_workspace "$workspace" .venv/bin/python -m pytest -q "$@"
    else
        infra_error "python venv not found in $workspace — run ./bootstrap first"
    fi
}

# run_ts_tests <workspace>
# Runs npm test from the workspace.
run_ts_tests() {
    local workspace="$1"
    run_in_workspace "$workspace" npm test
}

# run_go_tests <workspace>
# Runs go test from the workspace.
run_go_tests() {
    local workspace="$1"
    run_in_workspace "$workspace" go test ./...
}

# run_rust_tests <workspace>
# Runs cargo test from the workspace.
run_rust_tests() {
    local workspace="$1"
    run_in_workspace "$workspace" cargo test --quiet
}

# run_java_tests <workspace>
# Runs Maven test from the workspace. Requires JAVA_HOME to be discoverable.
run_java_tests() {
    local workspace="$1"
    run_in_workspace "$workspace" ./mvnw -q -B test
}

# ── Probe contract validation ──

# validate_probe_args <workspace> <base-ref> <scratch-dir>
# Ensures probe arguments are present and valid. Call at start of probe.
validate_probe_args() {
    local workspace="${1:-}"
    local base_ref="${2:-}"
    local scratch="${3:-}"

    if [ -z "$workspace" ]; then
        infra_error "missing required argument: <workspace>"
    fi
    if [ ! -d "$workspace" ]; then
        infra_error "workspace '$workspace' does not exist"
    fi
    if [ -z "$scratch" ]; then
        infra_error "missing required argument: <scratch-dir>"
    fi
    if [ -n "$scratch" ]; then
        mkdir -p "$scratch"
    fi
}
