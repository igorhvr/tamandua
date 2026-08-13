#!/usr/bin/env bash
# tt-provision-home.test.sh — self-test for tt-provision-home
# Validates E2.6 US-004 minimal-file harness-credential surfacing:
# enumerated minimal pi/hermes files only (no whole-dir copy), env API-key
# materialization (pi auth.json + hermes .env), idempotency, audit rewriting,
# .ssh absence, and scripted-home isolation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-provision-home"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-provision-home self-test ==="

# ── Test 1: --help documents the enumerated minimal set ───────────────
echo ""
echo "--- Test: --help ---"
if "$TOOL" --help | grep -q "Usage:"; then
  pass "--help prints usage"
else
  fail "--help did not print usage"
fi

if "$TOOL" --help | grep -q "settings.json" && "$TOOL" --help | grep -q "MINIMAL enumerated set"; then
  pass "--help documents the enumerated minimal pi files"
else
  fail "--help does not document the enumerated minimal pi files"
fi

if "$TOOL" --help | grep -q "DEEPSEEK_API_KEY" && "$TOOL" --help | grep -q "state.db"; then
  pass "--help documents env-key surfacing + whole-dir exclusion"
else
  fail "--help does not document env-key surfacing / whole-dir exclusion"
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

cleanup() {
  rm -rf "$MOCK_HOME" "$TEST_VAR"
}
trap cleanup EXIT

# Create mock ~/.pi with the enumerated files (settings.json + models.json).
mkdir -p "$MOCK_HOME/.pi/agent"
cat > "$MOCK_HOME/.pi/agent/settings.json" <<JSON
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "agentDir": "${MOCK_HOME}/.pi/agent"
}
JSON
cat > "$MOCK_HOME/.pi/agent/models.json" <<JSON
{
  "providers": {
    "local-dspark": {
      "baseUrl": "http://ai.iasylum.net:8888/v1",
      "apiKey": "local"
    }
  }
}
JSON
# Operator auth.json base (merged with env keys by the helper).
echo '{}' > "$MOCK_HOME/.pi/agent/auth.json"

# Create mock ~/.hermes with the enumerated files (config.yaml + auth.json)
# plus a big state.db and a sessions dir that MUST NOT be surfaced.
mkdir -p "$MOCK_HOME/.hermes/sessions"
cat > "$MOCK_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
  provider: openai-codex
YAML
cat > "$MOCK_HOME/.hermes/auth.json" <<JSON
{"version":1,"providers":{"openai-codex":{"tokens":{"id_token":"jwt-abc"}}}}
JSON
echo "1.5GB-junk" > "$MOCK_HOME/.hermes/state.db"
echo "session-junk" > "$MOCK_HOME/.hermes/sessions/s1.json"

# NOTE: we run the tool with HOME=MOCK_HOME and TT_VAR=TEST_VAR, and pin the
# API-key env vars we want surfaced so the test is deterministic regardless of
# what the operator's real environment happens to export.
run_tool() {
  HOME="$MOCK_HOME" TT_OPERATOR_HOME="$MOCK_HOME" TT_VAR="$TEST_VAR" \
    DEEPSEEK_API_KEY="sk-test-deepseek" \
    OPENAI_API_KEY="sk-test-openai" \
    ANTHROPIC_API_KEY="sk-test-anthropic" \
    MINIMAX_API_KEY="" \
    "$TOOL" "$@"
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

# ── Test 3: only the enumerated minimal files are surfaced ───────────
echo ""
echo "--- Test: enumerated minimal-file surfacing ---"

expect_file() {
  local path="$1" label="$2"
  if [ -f "$path" ]; then
    pass "$label exists"
  else
    fail "$label missing: $path"
  fi
}

expect_file "$REAL_TT_HOME/.pi/agent/settings.json" ".pi/agent/settings.json"
expect_file "$REAL_TT_HOME/.pi/agent/models.json"   ".pi/agent/models.json"
expect_file "$REAL_TT_HOME/.pi/agent/auth.json"     ".pi/agent/auth.json"
expect_file "$REAL_TT_HOME/.hermes/config.yaml"     ".hermes/config.yaml"
expect_file "$REAL_TT_HOME/.hermes/auth.json"       ".hermes/auth.json"

if [ -f "$REAL_TT_HOME/.hermes/.env" ]; then
  pass ".hermes/.env created (env keys surfaced)"
else
  fail ".hermes/.env missing"
fi

# Whole ~/.hermes state MUST NOT be surfaced (AC1).
if [ ! -f "$REAL_TT_HOME/.hermes/state.db" ]; then
  pass "~/.hermes/state.db NOT surfaced (no whole-dir copy)"
else
  fail "~/.hermes/state.db WAS surfaced — whole-dir copy regression"
fi

if [ ! -e "$REAL_TT_HOME/.hermes/sessions" ]; then
  pass "~/.hermes/sessions NOT surfaced"
else
  fail "~/.hermes/sessions WAS surfaced"
fi

if [ ! -e "$REAL_TT_HOME/.pi/agent/sessions" ]; then
  pass "~/.pi/agent/sessions NOT surfaced"
else
  fail "~/.pi/agent/sessions WAS surfaced"
fi

# ── Test 4: env API keys materialized into pi auth.json ──────────────
echo ""
echo "--- Test: pi auth.json env-key merge ---"

PI_AUTH="$REAL_TT_HOME/.pi/agent/auth.json"
if grep -q '"deepseek"' "$PI_AUTH" && grep -q 'sk-test-deepseek' "$PI_AUTH"; then
  pass "pi auth.json contains merged deepseek key"
else
  fail "pi auth.json missing merged deepseek key: $(cat "$PI_AUTH")"
fi

if grep -q '"openai"' "$PI_AUTH" && grep -q 'sk-test-openai' "$PI_AUTH"; then
  pass "pi auth.json contains merged openai key"
else
  fail "pi auth.json missing merged openai key"
fi

if [ "$(stat -c '%a' "$PI_AUTH" 2>/dev/null || stat -f '%Lp' "$PI_AUTH")" = "600" ]; then
  pass "pi auth.json is 0600"
else
  fail "pi auth.json is not 0600"
fi

# ── Test 5: env API keys materialized into hermes .env ───────────────
echo ""
echo "--- Test: hermes .env env-key surfacing ---"

HERMES_ENV="$REAL_TT_HOME/.hermes/.env"
if grep -q '^DEEPSEEK_API_KEY=sk-test-deepseek$' "$HERMES_ENV"; then
  pass "hermes .env contains DEEPSEEK_API_KEY"
else
  fail "hermes .env missing DEEPSEEK_API_KEY: $(cat "$HERMES_ENV")"
fi

if grep -q '^OPENAI_API_KEY=sk-test-openai$' "$HERMES_ENV"; then
  pass "hermes .env contains OPENAI_API_KEY"
else
  fail "hermes .env missing OPENAI_API_KEY"
fi

# ── Test 6: path rewriting (audit) ───────────────────────────────────
echo ""
echo "--- Test: path rewriting ---"

if ! grep -qF "$MOCK_HOME" "$REAL_TT_HOME/.pi/agent/settings.json"; then
  pass "mock HOME path NOT found in copied settings.json (rewritten)"
else
  fail "mock HOME path found in settings.json — NOT rewritten"
fi

if grep -qF "$REAL_TT_HOME" "$REAL_TT_HOME/.pi/agent/settings.json"; then
  pass "TT_HOME path FOUND in copied settings.json (correct rewrite target)"
else
  fail "TT_HOME path NOT found in settings.json"
fi

AUDIT_FILE="$REAL_TT_HOME/provision-audit.json"
if [ -f "$AUDIT_FILE" ] && grep -q "settings.json" "$AUDIT_FILE"; then
  pass "provision-audit.json records settings.json rewrite"
else
  fail "provision-audit.json missing settings.json rewrite"
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

SNAP_BEFORE="$(find "$REAL_TT_HOME" -type f -exec sha256sum {} \; | sort | sha256sum)"

run_tool 2>/dev/null

SNAP_AFTER="$(find "$REAL_TT_HOME" -type f -exec sha256sum {} \; | sort | sha256sum)"

if [ "$SNAP_BEFORE" = "$SNAP_AFTER" ]; then
  pass "contained home unchanged after second run (idempotent)"
else
  fail "contained home CHANGED after second run (churn)"
fi

# ── Test 9: No npm dependencies (bash shebang) ───────────────────────
echo ""
echo "--- Test: no npm dependencies ---"

if head -1 "$TOOL" | grep -q "bash"; then
  pass "tool is a bash script"
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
