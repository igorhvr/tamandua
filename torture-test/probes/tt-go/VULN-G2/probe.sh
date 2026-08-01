#!/usr/bin/env bash
# Probe: VULN-G2 — path traversal (tar entry header.Name used without sanitization)
# Fixture: tt-go
# Task type: vuln
#
# Checks:
#   1. ExtractTar resolves target path to absolute before writing
#   2. ExtractTar verifies target has dest as prefix (path containment guard)
#   3. No direct filepath.Join(dest, header.Name) without validation

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

ARCHIVE_FILE="$WORKSPACE/util/archive.go"
check_file_exists "$ARCHIVE_FILE" "util/archive.go not found in workspace"

# ── 1. Path traversal guard present ──
echo "[] Checking for path traversal guard..." >&2

assert_grep 'strings\.HasPrefix\|HasPrefix' "$ARCHIVE_FILE" \
    "VULN-G2 not fixed: no path containment check (HasPrefix) in ExtractTar"

# ── 2. Absolute path resolution ──
echo "[] Checking for target path resolution..." >&2

assert_grep 'filepath\.Abs' "$ARCHIVE_FILE" \
    "VULN-G2 not fixed: target path not resolved with filepath.Abs"

# ── 3. Path traversal rejection (return error on escape attempt) ──
echo "[] Checking for traversal rejection..." >&2

assert_grep 'path traversal\|escape\|outside' "$ARCHIVE_FILE" \
    "VULN-G2 not fixed: no path traversal detection/error message"

pass_ "VULN-G2: ExtractTar has path containment guard (filepath.Abs + HasPrefix), rejects traversal attempts"
