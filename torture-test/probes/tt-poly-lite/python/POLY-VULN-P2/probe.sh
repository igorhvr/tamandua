#!/usr/bin/env bash
# Probe: POLY-VULN-P2 — subprocess.run(..., shell=True) injection
# Fixture: tt-poly-lite (python/ subtree)
# Task type: vuln (dormant vulnerability in integrations.py)
#
# Checks:
#   1. No shell=True in subprocess.run calls in integrations.py
#   2. Function signatures use args: list[str] (not command: str)
# Dormant in baseline — no revert-probe needed

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

PY_WORKSPACE="$WORKSPACE/python"
INTEGRATIONS_FILE="$PY_WORKSPACE/src/schedlib/integrations.py"

check_file_exists "$INTEGRATIONS_FILE" "integrations.py not found in python/ workspace"

# ── 1. No shell=True in subprocess.run calls ──
echo "[] Checking for absence of shell=True..." >&2
# Exclude comment lines (POLY-VULN-P2: ... shell=True in documentation)
assert_not_grep '^[^#]*shell\s*=\s*True' "$INTEGRATIONS_FILE" \
    "POLY-VULN-P2 not fixed: shell=True still present in subprocess.run call"

# ── 2. Uses args: list[str], not command: str ──
echo "[] Checking for args: list[str] signatures..." >&2
# The fixed version has `args: list[str]` parameter
assert_grep 'args[[:space:]]*:[[:space:]]*list\[str\]' "$INTEGRATIONS_FILE" \
    "POLY-VULN-P2 not fixed: function signatures still use command: str instead of args: list[str]"

# ── 3. Confirm no command: str signature remaining ──
echo "[] Checking for absence of command: str..." >&2
assert_not_grep 'command[[:space:]]*:[[:space:]]*str' "$INTEGRATIONS_FILE" \
    "POLY-VULN-P2 not fixed: command: str signature still present"

pass_ "POLY-VULN-P2: no shell=True, uses args: list[str] signatures"
