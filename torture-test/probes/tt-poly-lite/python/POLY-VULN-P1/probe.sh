#!/usr/bin/env bash
# Probe: POLY-VULN-P1 — unsafe yaml.load() deserialization
# Fixture: tt-poly-lite (python/ subtree)
# Task type: vuln (dormant vulnerability in integrations.py)
#
# Checks:
#   1. No yaml.load() with Loader= parameter in integrations.py
#   2. Uses yaml.safe_load() instead
# Dormant in baseline — no revert-probe needed

source "$(dirname "$0")/../../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"
INTEGRATIONS_FILE="$PY_WORKSPACE/src/schedlib/integrations.py"

check_file_exists "$INTEGRATIONS_FILE" "integrations.py not found in python/ workspace"

# ── 1. Must use yaml.safe_load ──
echo "[] Checking for yaml.safe_load..." >&2
assert_grep 'yaml\.safe_load' "$INTEGRATIONS_FILE" \
    "POLY-VULN-P1 not fixed: yaml.safe_load not found in integrations.py"

# ── 2. Must NOT contain yaml.load with Loader= parameter ──
echo "[] Checking for absence of unsafe yaml.load..." >&2
assert_not_grep 'yaml\.load.*Loader' "$INTEGRATIONS_FILE" \
    "POLY-VULN-P1 not fixed: yaml.load with Loader= still present in integrations.py"

pass_ "POLY-VULN-P1: uses yaml.safe_load, no unsafe yaml.load with Loader"
