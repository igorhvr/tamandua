#!/usr/bin/env bash
# tt-provision-home.test.sh — self-test for tt-provision-home
# Validates idempotency, .gitconfig content, copy+audit, and .ssh absence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-provision-home"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-provision-home self-test ==="

# ── Test 1: --help ────────────────────────────────────────────────────
echo ""
echo "--- Test: --help ---"
if "$TOOL" --help | grep -q "Usage:"; then
  pass "--help prints usage"
else
  fail "--help did not print usage"
fi

if "$TOOL" --help > /dev/null 2>&1; then
  pass "--help exits 0"
else
  fail "--help did not exit 0"
fi

if "$TOOL" -h | grep -q "Usage:"; then
  pass "-h prints usage (short form)"
else
  fail "-h did not print usage"
fi

# ── Setup: mock HOME and TT_VAR ───────────────────────────────────────
echo ""
echo "--- Setup: mock HOME and TT_VAR ---"

MOCK_HOME="$(mktemp -d)"
TEST_VAR="$(mktemp -d)"

# Clean up on exit
cleanup() {
  rm -rf "$MOCK_HOME" "$TEST_VAR"
}
trap cleanup EXIT

# Create mock ~/.pi with a file containing HOME references.
# We write the mock HOME path explicitly (not via bash expansion) so the
# tool's audit pass will find and rewrite them.
mkdir -p "$MOCK_HOME/.pi"
cat > "$MOCK_HOME/.pi/settings.json" <<JSON
{
  "agentDir": "${MOCK_HOME}/.pi/agent",
  "model": "claude-sonnet-4-20250514",
  "settings": {
    "cache": "${MOCK_HOME}/.pi/cache"
  }
}
JSON

# Create mock ~/.hermes with a file containing HOME references
mkdir -p "$MOCK_HOME/.hermes"
cat > "$MOCK_HOME/.hermes/config.json" <<JSON
{
  "home": "${MOCK_HOME}/.hermes",
  "state_db": "${MOCK_HOME}/.hermes/state.db"
}
JSON

# Also add a file without any HOME references
echo '{"debug": false}' > "$MOCK_HOME/.pi/noop.json"

# NOTE: We run the tool with HOME=MOCK_HOME and TT_VAR=TEST_VAR
run_tool() {
  HOME="$MOCK_HOME" TT_VAR="$TEST_VAR" "$TOOL" "$@"
}

REAL_TT_HOME="$TEST_VAR/home"
SCRIPTED_TT_HOME="$TEST_VAR/home-scripted"

pass "mock HOME and test var directories created"

# ── Test 2: First run creates .gitconfig files ───────────────────────
echo ""
echo "--- Test: first run creates .gitconfig ---"

run_tool 2>/dev/null

if [ -f "$REAL_TT_HOME/.gitconfig" ]; then
  pass "real TT_HOME/.gitconfig created"
else
  fail "real TT_HOME/.gitconfig NOT created"
fi

if [ -f "$SCRIPTED_TT_HOME/.gitconfig" ]; then
  pass "scripted TT_HOME/.gitconfig created"
else
  fail "scripted TT_HOME/.gitconfig NOT created"
fi

# ── Test 3: .gitconfig content is correct ────────────────────────────
echo ""
echo "--- Test: .gitconfig content ---"

check_gitconfig_field() {
  local file="$1" section="$2" key="$3" expected="$4" label="$5"
  local actual
  # Use git config to read the value; works even if file is not in a repo
  actual="$(git config -f "$file" --get "$section.$key" 2>/dev/null || echo "MISSING")"
  if [ "$actual" = "$expected" ]; then
    pass "$label: $section.$key = $expected"
  else
    fail "$label: expected $section.$key=$expected, got '$actual'"
  fi
}

check_gitconfig_field "$REAL_TT_HOME/.gitconfig" "user" "name" "Tamandua Torture Test" "real user.name"
check_gitconfig_field "$REAL_TT_HOME/.gitconfig" "user" "email" "tt@tamandua.test" "real user.email"
check_gitconfig_field "$REAL_TT_HOME/.gitconfig" "commit" "gpgsign" "false" "real commit.gpgsign"
check_gitconfig_field "$REAL_TT_HOME/.gitconfig" "init" "defaultBranch" "main" "real init.defaultBranch"
check_gitconfig_field "$REAL_TT_HOME/.gitconfig" "pull" "ff" "only" "real pull.ff"

check_gitconfig_field "$SCRIPTED_TT_HOME/.gitconfig" "user" "name" "Tamandua Torture Test" "scripted user.name"
check_gitconfig_field "$SCRIPTED_TT_HOME/.gitconfig" "user" "email" "tt@tamandua.test" "scripted user.email"
check_gitconfig_field "$SCRIPTED_TT_HOME/.gitconfig" "commit" "gpgsign" "false" "scripted commit.gpgsign"
check_gitconfig_field "$SCRIPTED_TT_HOME/.gitconfig" "init" "defaultBranch" "main" "scripted init.defaultBranch"
check_gitconfig_field "$SCRIPTED_TT_HOME/.gitconfig" "pull" "ff" "only" "scripted pull.ff"

# ── Test 4: ~/.pi and ~/.hermes were copied (not symlinked) ──────────
echo ""
echo "--- Test: ~/.pi and ~/.hermes copies ---"

if [ -d "$REAL_TT_HOME/.pi" ]; then
  pass "real TT_HOME/.pi directory exists"
else
  fail "real TT_HOME/.pi directory missing"
fi

if [ -d "$REAL_TT_HOME/.hermes" ]; then
  pass "real TT_HOME/.hermes directory exists"
else
  fail "real TT_HOME/.hermes directory missing"
fi

# Verify they are NOT symlinks
if [ ! -L "$REAL_TT_HOME/.pi" ]; then
  pass "real TT_HOME/.pi is NOT a symlink"
else
  fail "real TT_HOME/.pi IS a symlink (should be a copy)"
fi

if [ ! -L "$REAL_TT_HOME/.hermes" ]; then
  pass "real TT_HOME/.hermes is NOT a symlink"
else
  fail "real TT_HOME/.hermes IS a symlink (should be a copy)"
fi

# ── Test 5: path rewriting ────────────────────────────────────────────
echo ""
echo "--- Test: path rewriting ---"

# The mock content had MOCK_HOME references; they should be rewritten to REAL_TT_HOME
if ! grep -qF "$MOCK_HOME" "$REAL_TT_HOME/.pi/settings.json"; then
  pass "mock HOME path NOT found in copied .pi/settings.json (rewritten)"
else
  fail "mock HOME path found in .pi/settings.json — NOT rewritten"
fi

if grep -qF "$REAL_TT_HOME" "$REAL_TT_HOME/.pi/settings.json"; then
  pass "TT_HOME path FOUND in copied .pi/settings.json (correct rewrite target)"
else
  fail "TT_HOME path NOT found in copied .pi/settings.json"
fi

if ! grep -qF "$MOCK_HOME" "$REAL_TT_HOME/.hermes/config.json"; then
  pass "mock HOME path NOT found in copied .hermes/config.json (rewritten)"
else
  fail "mock HOME path found in .hermes/config.json — NOT rewritten"
fi

if grep -qF "$REAL_TT_HOME" "$REAL_TT_HOME/.hermes/config.json"; then
  pass "TT_HOME path FOUND in copied .hermes/config.json (correct rewrite target)"
else
  fail "TT_HOME path NOT found in copied .hermes/config.json"
fi

# File without HOME references should be untouched
if [ -f "$REAL_TT_HOME/.pi/noop.json" ]; then
  pass "copied file without HOME references preserved"
else
  fail "copied file without HOME references is missing"
fi

# ── Test 6: provision-audit.json ─────────────────────────────────────
echo ""
echo "--- Test: provision-audit.json ---"

AUDIT_FILE="$REAL_TT_HOME/provision-audit.json"

if [ -f "$AUDIT_FILE" ]; then
  pass "provision-audit.json exists"
else
  fail "provision-audit.json NOT created"
fi

if [ -s "$AUDIT_FILE" ]; then
  pass "provision-audit.json is non-empty (rewrites recorded)"
else
  fail "provision-audit.json is empty (no rewrites recorded)"
fi

if grep -q "settings.json" "$AUDIT_FILE" 2>/dev/null; then
  pass "audit file records rewrite in settings.json"
else
  fail "audit file missing rewrite for settings.json"
fi

if grep -q "config.json" "$AUDIT_FILE" 2>/dev/null; then
  pass "audit file records rewrite in config.json"
else
  fail "audit file missing rewrite for config.json"
fi

# ── Test 7: No .ssh in either TT_HOME ────────────────────────────────
echo ""
echo "--- Test: no .ssh directories ---"

if [ ! -d "$REAL_TT_HOME/.ssh" ]; then
  pass "No .ssh directory in real TT_HOME"
else
  fail ".ssh directory EXISTS in real TT_HOME"
fi

if [ ! -d "$SCRIPTED_TT_HOME/.ssh" ]; then
  pass "No .ssh directory in scripted TT_HOME"
else
  fail ".ssh directory EXISTS in scripted TT_HOME"
fi

# ── Test 8: Idempotency — second run is a no-op ──────────────────────
echo ""
echo "--- Test: idempotency (second run) ---"

# Snapshot state before second run
GITCONFIG_SHA_BEFORE="$(sha256sum "$REAL_TT_HOME/.gitconfig" | awk '{print $1}')"
PI_SETTINGS_SHA_BEFORE="$(sha256sum "$REAL_TT_HOME/.pi/settings.json" | awk '{print $1}')"
HERMES_CONFIG_SHA_BEFORE="$(sha256sum "$REAL_TT_HOME/.hermes/config.json" | awk '{print $1}')"
SCRIPTED_GITCONFIG_SHA_BEFORE="$(sha256sum "$SCRIPTED_TT_HOME/.gitconfig" | awk '{print $1}')"

# Run tool again
run_tool 2>/dev/null

GITCONFIG_SHA_AFTER="$(sha256sum "$REAL_TT_HOME/.gitconfig" | awk '{print $1}')"
PI_SETTINGS_SHA_AFTER="$(sha256sum "$REAL_TT_HOME/.pi/settings.json" | awk '{print $1}')"
HERMES_CONFIG_SHA_AFTER="$(sha256sum "$REAL_TT_HOME/.hermes/config.json" | awk '{print $1}')"
SCRIPTED_GITCONFIG_SHA_AFTER="$(sha256sum "$SCRIPTED_TT_HOME/.gitconfig" | awk '{print $1}')"

if [ "$GITCONFIG_SHA_BEFORE" = "$GITCONFIG_SHA_AFTER" ]; then
  pass "real .gitconfig unchanged after second run (idempotent)"
else
  fail "real .gitconfig CHANGED after second run"
fi

if [ "$PI_SETTINGS_SHA_BEFORE" = "$PI_SETTINGS_SHA_AFTER" ]; then
  pass ".pi/settings.json unchanged after second run (idempotent)"
else
  fail ".pi/settings.json CHANGED after second run"
fi

if [ "$HERMES_CONFIG_SHA_BEFORE" = "$HERMES_CONFIG_SHA_AFTER" ]; then
  pass ".hermes/config.json unchanged after second run (idempotent)"
else
  fail ".hermes/config.json CHANGED after second run"
fi

if [ "$SCRIPTED_GITCONFIG_SHA_BEFORE" = "$SCRIPTED_GITCONFIG_SHA_AFTER" ]; then
  pass "scripted .gitconfig unchanged after second run (idempotent)"
else
  fail "scripted .gitconfig CHANGED after second run"
fi

# ── Test 9: No npm dependencies ──────────────────────────────────────
echo ""
echo "--- Test: no npm dependencies ---"

if head -1 "$TOOL" | grep -q "bash"; then
  pass "tool is a bash script (no npm needed)"
else
  fail "tool shebang is not bash"
fi

# ── Test 10: Scripted TT_HOME has NO .pi/.hermes copies ──────────────
echo ""
echo "--- Test: scripted TT_HOME has no copies ---"

if [ ! -d "$SCRIPTED_TT_HOME/.pi" ]; then
  pass "scripted TT_HOME has NO .pi directory (as expected)"
else
  fail "scripted TT_HOME HAS .pi directory (should not)"
fi

if [ ! -d "$SCRIPTED_TT_HOME/.hermes" ]; then
  pass "scripted TT_HOME has NO .hermes directory (as expected)"
else
  fail "scripted TT_HOME HAS .hermes directory (should not)"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "================================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAILURES test(s) FAILED"
  exit 1
fi
