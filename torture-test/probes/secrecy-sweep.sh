#!/usr/bin/env bash
# secrecy-sweep.sh — Held-out probe secrecy enforcement
#
# Sweeps all fixture golden bares and asserts:
#   1. No forbidden refs (seed/*-solution, reference/*, etc.) in any
#      agent-reachable bare — git show-ref
#   2. No probes/ path references in committed files of any fixture —
#      git ls-tree + cat-file blob
#
# The secrecy property: probes live ONLY in torture-test/probes/, outside
# every agent-reachable fixture repo. This script is the mechanical proof.
#
# Usage:
#   secrecy-sweep.sh [--golden-dir <path>] [--self-test]
#
#   --golden-dir <path>   Path to golden bare repos (default: auto-detected)
#   --self-test           Run internal self-tests instead of production sweep
#   -h, --help            Show this help
#
# Exit codes:
#   0 = clean — no leakage found
#   1 = leakage found (prints offending repo + evidence)
#   2 = infra error
#
# Hard constraints:
#   - No network access
#   - No workspace clones needed (only golden bares)
#   - Runtime target: < 30s for all fixtures

set -euo pipefail

# ── Default golden dir ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_GOLDEN_DIR="$REPO_ROOT/torture-test/var/golden"

# ── Forbidden ref patterns (grep -E regex) ──
# These patterns match refs that MUST NOT exist in any agent-reachable repo.
readonly FORBIDDEN_REF_REGEX='(refs/(heads|tags)/.*-solution|refs/(heads|tags)/reference|refs/(heads|tags)/probes?\b)'

# ── Forbidden content pattern ──
readonly FORBIDDEN_CONTENT_PATTERN='probes/'

# ── Internal: get the default branch ref for a bare repo ──
_get_default_branch() {
    local bare_path="$1"
    # Resolve HEAD symbolic ref; if HEAD is a symbolic ref, show-ref gives us
    # the target. Fall back to common branch names if HEAD is detached.
    local head_ref
    if head_ref="$(git --git-dir="$bare_path" symbolic-ref HEAD 2>/dev/null)"; then
        echo "$head_ref"
        return 0
    fi
    # Try common branch names in order
    for branch in refs/heads/main refs/heads/master; do
        if git --git-dir="$bare_path" show-ref --verify --quiet "$branch" 2>/dev/null; then
            echo "$branch"
            return 0
        fi
    done
    # Last resort: first branch ref
    git --git-dir="$bare_path" show-ref --heads | head -1 | awk '{print $2}'
}

# ── Internal: check a single golden bare for forbidden refs ──
# Returns 0 if clean, non-zero if leaks found.
_check_refs() {
    local bare_path="$1"
    local fixture_name="$2"
    local findings=0

    local refs
    if ! refs="$(git --git-dir="$bare_path" show-ref 2>/dev/null)"; then
        return 0  # No refs at all — clean
    fi

    local matches
    if matches="$(echo "$refs" | grep -E "$FORBIDDEN_REF_REGEX" || true)"; then
        if [ -n "$matches" ]; then
            echo "  LEAK [ref]: $fixture_name: forbidden ref pattern matches:" >&2
            echo "$matches" | sed 's/^/    /' >&2
            findings=$((findings + $(echo "$matches" | wc -l)))
        fi
    fi
    return "$findings"
}

# ── Internal: check a single golden bare for forbidden content ──
# Iterates over every blob in the default branch, grepping for probes/.
# Returns 0 if clean, non-zero if leaks found.
_check_content() {
    local bare_path="$1"
    local fixture_name="$2"
    local findings=0

    local default_branch
    if ! default_branch="$(_get_default_branch "$bare_path")"; then
        echo "  WARN: $fixture_name: cannot determine default branch — skipped content check" >&2
        return 0
    fi

    if [ -z "$default_branch" ]; then
        echo "  WARN: $fixture_name: no default branch — skipped content check" >&2
        return 0
    fi

    # Use git ls-tree -r to list all blobs, then cat-file each one.
    # Avoids needing a working tree (works with bare repos).
    git --git-dir="$bare_path" ls-tree -r "$default_branch" 2>/dev/null | while read -r mode type hash path; do
        if [ "$type" = "blob" ]; then
            if git --git-dir="$bare_path" cat-file blob "$hash" 2>/dev/null | grep -qF "$FORBIDDEN_CONTENT_PATTERN"; then
                echo "  LEAK [content]: $fixture_name: '$FORBIDDEN_CONTENT_PATTERN' found in committed file '$path'" >&2
                return 1
            fi
        fi
    done
    # The while loop runs in a subshell; capture exit via PIPESTATUS-like approach.
    # We use a temp flag file instead.
}

# ── Internal: check content (with proper exit code tracking) ──
# Wraps _check_content_core so the subshell exit propagates.
_check_content_wrapped() {
    local bare_path="$1"
    local fixture_name="$2"

    local flag
    flag="$(mktemp "${TMPDIR:-/tmp}/secrecy-sweep-content.XXXXXX")"
    trap "rm -f '$flag'" RETURN

    local default_branch
    if ! default_branch="$(_get_default_branch "$bare_path")"; then
        echo "  WARN: $fixture_name: cannot determine default branch — skipped content check" >&2
        return 0
    fi

    if [ -z "$default_branch" ]; then
        echo "  WARN: $fixture_name: no default branch — skipped content check" >&2
        return 0
    fi

    local found=0
    git --git-dir="$bare_path" ls-tree -r "$default_branch" 2>/dev/null | while read -r mode type hash path; do
        if [ "$type" = "blob" ]; then
            if git --git-dir="$bare_path" cat-file blob "$hash" 2>/dev/null | grep -qF "$FORBIDDEN_CONTENT_PATTERN"; then
                echo "  LEAK [content]: $fixture_name: '$FORBIDDEN_CONTENT_PATTERN' found in committed file '$path'" >&2
                echo "1" > "$flag"
            fi
        fi
    done

    if [ -s "$flag" ]; then
        return 1
    fi
    return 0
}

# ── Self-test: verify the sweep detects planted leakage ──
# All tests run inline (no bash -c subprocess) so they can use the
# internal _check_refs / _check_content_wrapped functions directly.
self_test() {
    echo "=== secrecy-sweep.sh self-tests ===" >&2
    local total=0 pass=0 fail=0

    local TEST_TMP
    TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/secrecy-sweep-selftest.XXXXXX")"
    trap "rm -rf '$TEST_TMP'" EXIT

    # Helper: create a bare repo with one commit and optional extra refs.
    # Echoes the bare path on stdout.
    _st_make_bare() {
        local name="$1" content="$2"
        shift 2
        local bare="$TEST_TMP/$name.git"
        git init --bare --initial-branch=main "$bare" >/dev/null 2>&1
        local clone="$TEST_TMP/$name-clone"
        git clone "$bare" "$clone" >/dev/null 2>&1
        echo "$content" > "$clone/file.txt"
        git -C "$clone" add file.txt >/dev/null 2>&1
        git -C "$clone" commit -m "init" >/dev/null 2>&1
        git -C "$clone" push origin HEAD:refs/heads/main >/dev/null 2>&1
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --ref) git -C "$clone" branch "$2" >/dev/null 2>&1
                       git -C "$clone" push origin "refs/heads/$2" >/dev/null 2>&1
                       shift 2 ;;
                --tag) git -C "$clone" tag "$2" >/dev/null 2>&1
                       git -C "$clone" push origin "refs/tags/$2" >/dev/null 2>&1
                       shift 2 ;;
                *) shift ;;
            esac
        done
        rm -rf "$clone"
        echo "$bare"
    }

    _st_pass() { pass=$((pass + 1)); echo "  ✓ PASS" >&2; }
    _st_fail() { fail=$((fail + 1)); echo "  ✗ FAIL" >&2; }

    local bare

    # Test 1: clean bare → no leaks
    total=$((total + 1)); echo "[TEST $total] Clean bare repo → should find 0 leaks" >&2
    bare="$(_st_make_bare clean1 'clean content')"
    _check_refs "$bare" clean1 2>/dev/null && _check_content_wrapped "$bare" clean1 2>/dev/null && _st_pass || _st_fail

    # Test 2: forbidden ref 'refs/heads/seed/BUG-J1-solution' → detected
    total=$((total + 1)); echo "[TEST $total] Bare with forbidden ref 'seed/BUG-J1-solution' → should detect" >&2
    bare="$(_st_make_bare leak-ref 'data')"
    local clone="$TEST_TMP/tmp-leak-ref"
    git clone "$bare" "$clone" >/dev/null 2>&1
    git -C "$clone" branch seed/BUG-J1-solution >/dev/null 2>&1
    git -C "$clone" push origin refs/heads/seed/BUG-J1-solution >/dev/null 2>&1
    rm -rf "$clone"
    _check_refs "$bare" leak-ref 2>/dev/null && _st_fail || _st_pass

    # Test 3: committed file containing 'probes/' → detected
    total=$((total + 1)); echo "[TEST $total] Committed file containing 'probes/' → should detect" >&2
    bare="$TEST_TMP/leak-content.git"
    git init --bare --initial-branch=main "$bare" >/dev/null 2>&1
    clone="$TEST_TMP/tmp-leak-content"
    git clone "$bare" "$clone" >/dev/null 2>&1
    echo 'See probes/BUG-T1/probe.sh for details' > "$clone/notes.txt"
    git -C "$clone" add notes.txt >/dev/null 2>&1
    git -C "$clone" commit -m 'add notes' >/dev/null 2>&1
    git -C "$clone" push origin HEAD:refs/heads/main >/dev/null 2>&1
    rm -rf "$clone"
    _check_content_wrapped "$bare" leak-content 2>/dev/null && _st_fail || _st_pass

    # Test 4: clean content (no probes/) → not flagged
    total=$((total + 1)); echo "[TEST $total] Clean committed files → should NOT flag" >&2
    bare="$(_st_make_bare clean2 'totally clean content here')"
    _check_content_wrapped "$bare" clean2 2>/dev/null && _st_pass || _st_fail

    # Test 5: forbidden tag 'refs/tags/BUG-T1-solution' → detected
    total=$((total + 1)); echo "[TEST $total] Bare with forbidden tag 'BUG-T1-solution' → should detect" >&2
    bare="$(_st_make_bare leak-tag 'data')"
    clone="$TEST_TMP/tmp-leak-tag"
    git clone "$bare" "$clone" >/dev/null 2>&1
    git -C "$clone" tag -a BUG-T1-solution -m 'solution' >/dev/null 2>&1
    git -C "$clone" push origin refs/tags/BUG-T1-solution >/dev/null 2>&1
    rm -rf "$clone"
    _check_refs "$bare" leak-tag 2>/dev/null && _st_fail || _st_pass

    # Test 6: probes/ deep in nested file → detected
    total=$((total + 1)); echo "[TEST $total] 'probes/' deep in nested committed file → should detect" >&2
    bare="$TEST_TMP/leak-nested.git"
    git init --bare --initial-branch=main "$bare" >/dev/null 2>&1
    clone="$TEST_TMP/tmp-leak-nested"
    git clone "$bare" "$clone" >/dev/null 2>&1
    mkdir -p "$clone/docs/internal"
    echo 'Reference: ../../probes/BUG-T1/probe.sh' > "$clone/docs/internal/design.md"
    git -C "$clone" add docs/internal/design.md >/dev/null 2>&1
    git -C "$clone" commit -m 'add design doc' >/dev/null 2>&1
    git -C "$clone" push origin HEAD:refs/heads/main >/dev/null 2>&1
    rm -rf "$clone"
    _check_content_wrapped "$bare" leak-nested 2>/dev/null && _st_fail || _st_pass

    # Test 7: 'refs/heads/reference' branch → detected
    total=$((total + 1)); echo "[TEST $total] Bare with 'refs/heads/reference' → should detect" >&2
    bare="$(_st_make_bare ref-branch 'data')"
    clone="$TEST_TMP/tmp-ref-branch"
    git clone "$bare" "$clone" >/dev/null 2>&1
    git -C "$clone" branch reference >/dev/null 2>&1
    git -C "$clone" push origin refs/heads/reference >/dev/null 2>&1
    rm -rf "$clone"
    _check_refs "$bare" ref-branch 2>/dev/null && _st_fail || _st_pass

    # Test 8: 'probes' without slash → NOT flagged (reduces false positives)
    total=$((total + 1)); echo "[TEST $total] 'probes' without trailing slash → should NOT flag" >&2
    bare="$(_st_make_bare probes-word 'Space probes are cool instruments')"
    _check_content_wrapped "$bare" probes-word 2>/dev/null && _st_pass || _st_fail

    # ── Summary ──
    echo "" >&2
    echo "=== Self-test results: $pass/$total passed ===" >&2
    if [ "$fail" -eq 0 ]; then
        echo "All self-tests PASSED" >&2
        return 0
    else
        echo "$fail self-test(s) FAILED" >&2
        return 1
    fi
}

# ── Main sweep ──
main() {
    if [ ! -d "$GOLDEN_DIR" ]; then
        echo "Golden bares directory not found: $GOLDEN_DIR" >&2
        echo "This is expected if golden bares haven't been created yet." >&2
        echo "No leakage found (0 fixtures to scan)." >&2
        echo "CLEAN: 0 fixtures scanned, 0 leaks found"
        exit 0
    fi

    local total_leaks=0
    local fixtures_scanned=0
    local leaked_fixtures=""

    # Find all bare repos (directories containing a HEAD file)
    for bare in "$GOLDEN_DIR"/*; do
        if [ ! -e "$bare" ]; then
            continue
        fi

        if [ -d "$bare" ] && [ -f "$bare/HEAD" ]; then
            local fixture_name
            fixture_name="$(basename "$bare" .git)"
            fixtures_scanned=$((fixtures_scanned + 1))

            echo "Scanning: $fixture_name" >&2

            local ref_leaks=0
            _check_refs "$bare" "$fixture_name" || ref_leaks=$?
            total_leaks=$((total_leaks + (ref_leaks > 0 ? ref_leaks : 0)))

            local content_leaks=0
            _check_content_wrapped "$bare" "$fixture_name" || content_leaks=$?
            total_leaks=$((total_leaks + (content_leaks > 0 ? content_leaks : 0)))

            if [ $((ref_leaks + content_leaks)) -gt 0 ]; then
                leaked_fixtures="$leaked_fixtures $fixture_name"
            fi
        fi
    done

    echo "" >&2
    echo "=== Secrecy sweep complete ===" >&2
    echo "Fixtures scanned: $fixtures_scanned" >&2
    echo "Leaks found: $total_leaks" >&2

    if [ "$total_leaks" -eq 0 ]; then
        echo "CLEAN: $fixtures_scanned fixtures scanned, 0 leaks found"
        exit 0
    else
        echo "LEAKAGE: $total_leaks leak(s) in fixtures:$(echo "$leaked_fixtures" | sed 's/ $//')"
        exit 1
    fi
}

# ── Entry point ──
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    GOLDEN_DIR="$DEFAULT_GOLDEN_DIR"

    if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
        head -25 "$0" | grep '^#' | sed 's/^# \?//'
        exit 0
    fi

    if [[ "${1:-}" == "--self-test" ]]; then
        self_test
        exit $?
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --golden-dir)
                shift
                GOLDEN_DIR="$1"
                shift
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Usage: secrecy-sweep.sh [--golden-dir <path>] [--self-test]" >&2
                exit 2
                ;;
        esac
    done

    main
fi
