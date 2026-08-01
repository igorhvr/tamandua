#!/usr/bin/env bash
# Probe: VULN-P2 — subprocess.run(..., shell=True) injection
# Fixture: tt-python
# Task type: vuln
#
# Checks:
#   1. No shell=True in subprocess.run calls in integrations.py
#   2. Function signatures use args: list[str], not command: str

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

INTEGRATIONS_FILE="$WORKSPACE/src/schedlib/integrations.py"
check_file_exists "$INTEGRATIONS_FILE" "integrations.py not found in workspace"

# ── 1. Must NOT contain shell=True in subprocess.run calls ──
echo "[] Checking for absence of shell=True..." >&2
# Use a more specific pattern to avoid matching comments
if grep -n 'shell=True' "$INTEGRATIONS_FILE" | grep -v '^[0-9]*:[ ]*#' | grep -q 'shell=True'; then
    fail "VULN-P2 not fixed: shell=True still present in integrations.py"
fi

# ── 2. Function signatures should use list[str] not str for command arg ──
echo "[] Checking function signatures..." >&2
if ! grep -q 'args.*list\[str\]' "$INTEGRATIONS_FILE"; then
    fail "VULN-P2 not fixed: function signatures should use 'args: list[str]' instead of 'command: str'"
fi

# ── 3. Confirm subprocess.run is called without shell=True ──
# (The call sites should pass args list, not command string)
if grep -q 'subprocess\.run' "$INTEGRATIONS_FILE" && \
   ! grep -q 'shell=False' "$INTEGRATIONS_FILE"; then
    # shell=False is the default — as long as shell=True is absent, we're good
    echo "[] shell=False is default — no shell=True present, ok" >&2
fi

pass_ "VULN-P2: no shell=True, uses args: list[str], injection vector removed"
