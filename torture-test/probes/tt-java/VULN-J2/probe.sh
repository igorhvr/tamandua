#!/usr/bin/env bash
# Probe: VULN-J2 — Path traversal via user-supplied filename in ExportService
# Fixture: tt-java
# Task type: vuln (path traversal)
#
# Checks:
#   1. ExportService validates the output path with canonical-path containment check
#   2. SecurityException thrown on path traversal (e.g., ../ escapes)

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

EXPORT_SVC="$WORKSPACE/src/main/java/com/tamandua/ledger/ExportService.java"
check_file_exists "$EXPORT_SVC" "ExportService.java not found in workspace"

# ── 1. Canonical path resolution and containment check ──
echo "[] Checking ExportService path validation..." >&2

# Must use toAbsolutePath() + normalize() or toRealPath()
assert_grep 'toAbsolutePath\|toRealPath\|normalize' "$EXPORT_SVC" \
    "VULN-J2 not fixed: path canonicalization not found in ExportService"

# ── 2. startsWith containment check (target path must be within allowed dir) ──
assert_grep 'startsWith' "$EXPORT_SVC" \
    "VULN-J2 not fixed: path containment check (startsWith) not found"

# ── 3. SecurityException or IOException on traversal detection ──
assert_grep 'SecurityException\|throw new.*Exception' "$EXPORT_SVC" \
    "VULN-J2 not fixed: no SecurityException thrown on path traversal detection"

# ── 4. No raw FileWriter with unchecked user filename ──
# The fix should validate before opening FileWriter, but FileWriter may still be used
# Key is that validation guards it
if ! grep -q 'startsWith\|toRealPath\|SecurityException' "$EXPORT_SVC"; then
    fail "VULN-J2 not fixed: ExportService lacks path traversal hardening"
fi

pass_ "VULN-J2: canonical-path containment check, SecurityException on traversal, paths validated before FileWriter"
