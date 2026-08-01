#!/usr/bin/env bash
# Probe: VULN-G1 — command injection (shell=True via sh -c with unsanitized cmdStr)
# Fixture: tt-go
# Task type: vuln
#
# Checks:
#   1. No RunCommandShell function using exec.Command("sh", "-c", ...)
#   2. RunCommandSafe exists and uses exec.Command with args list (no shell)
#   3. util/command.go does not import "os/exec" for shell execution

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

CMD_FILE="$WORKSPACE/util/command.go"
check_file_exists "$CMD_FILE" "util/command.go not found in workspace"

# ── 1. No shell-based command execution (sh -c) ──
echo "[] Checking for removed shell execution..." >&2

assert_not_grep '"sh"[[:space:]]*,[[:space:]]*"-c"' "$CMD_FILE" \
    "VULN-G1 not fixed: shell execution via sh -c still present in command.go"

assert_not_grep 'RunCommandShell' "$CMD_FILE" \
    "VULN-G1 not fixed: RunCommandShell still exists"

# ── 2. RunCommandSafe uses exec.Command with args only ──
echo "[] Checking for safe command execution..." >&2

assert_grep 'RunCommandSafe' "$CMD_FILE" \
    "VULN-G1 not fixed: no RunCommandSafe function found"

# RunCommandSafe must use args-based exec.Command, not shell string
assert_grep 'exec\.Command(args\[0\]\|exec\.Command(name' "$CMD_FILE" \
    "VULN-G1 not fixed: RunCommandSafe does not use args-list exec.Command"

pass_ "VULN-G1: RunCommandShell removed, RunCommandSafe uses args-list exec.Command"
