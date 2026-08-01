#!/usr/bin/env bash
# Probe: VULN-J1 — XXE (XML External Entity) injection via unsecured DocumentBuilderFactory
# Fixture: tt-java
# Task type: vuln (XXE)
#
# Checks:
#   1. XmlImportService configures DocumentBuilderFactory securely
#   2. DTD processing is disabled (disallow-doctype-decl)
#   3. External entities are disabled

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

XML_IMPORT="$WORKSPACE/src/main/java/com/tamandua/ledger/XmlImportService.java"
check_file_exists "$XML_IMPORT" "XmlImportService.java not found in workspace"

# ── 1. Security features enabled on DocumentBuilderFactory ──
echo "[] Checking DocumentBuilderFactory security configuration..." >&2

assert_grep 'FEATURE_SECURE_PROCESSING\|setFeature.*SECURE_PROCESSING' "$XML_IMPORT" \
    "VULN-J1 not fixed: FEATURE_SECURE_PROCESSING not enabled"

# ── 2. Disallow DOCTYPE declarations (prevents DOCTYPE-based XXE) ──
assert_grep 'disallow-doctype-decl\|DISALLOW_DOCTYPE_DECL' "$XML_IMPORT" \
    "VULN-J1 not fixed: disallow-doctype-decl not set"

# ── 3. External general entities disabled ──
assert_grep 'external-general-entities\|EXTERNAL_GENERAL_ENTITIES' "$XML_IMPORT" \
    "VULN-J1 not fixed: external general entities not disabled"

# ── 4. External parameter entities disabled ──
assert_grep 'external-parameter-entities\|EXTERNAL_PARAMETER_ENTITIES' "$XML_IMPORT" \
    "VULN-J1 not fixed: external parameter entities not disabled"

# ── 5. XInclude disabled ──
assert_grep 'XIncludeAware\|setXIncludeAware' "$XML_IMPORT" \
    "VULN-J1 not fixed: XIncludeAware not configured"

pass_ "VULN-J1: secure DocumentBuilderFactory config (FEATURE_SECURE_PROCESSING, disallow-doctype-decl, external entities disabled, XInclude disabled)"
