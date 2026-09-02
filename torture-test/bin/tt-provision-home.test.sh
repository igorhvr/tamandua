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

if "$TOOL" --help | grep -q "OPTIONAL-surface-if-present" && "$TOOL" --help | grep -q "REQUIRED"; then
  pass "--help documents the required-vs-optional pi file split"
else
  fail "--help does not document the required-vs-optional pi file split"
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
ABSENT_HOME="$(mktemp -d)"
ABSENT_VAR="$(mktemp -d)"
FIX_HOME="$(mktemp -d)"
FIX_VAR="$(mktemp -d)"
FIX_VAR2="$(mktemp -d)"
NOENV_HOME="$(mktemp -d)"
NOENV_VAR="$(mktemp -d)"

cleanup() {
  rm -rf "$MOCK_HOME" "$TEST_VAR" "$ABSENT_HOME" "$ABSENT_VAR" \
    "$FIX_HOME" "$FIX_VAR" "$FIX_VAR2" "$NOENV_HOME" "$NOENV_VAR"
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

# ── Test 11: models.json-absent operator HOME (MACP8 US-001) ─────────
echo ""
echo "--- Test: models.json absent (darwin operator shape) ---"

# darwin ~/.pi/agent legitimately has no models.json. The operator fixture
# here has settings.json + auth.json + hermes files but NO models.json; the
# run must exit 0, surface settings.json, and neither surface nor name
# models.json missing.
mkdir -p "$ABSENT_HOME/.pi/agent"
cat > "$ABSENT_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek","agentDir":"${ABSENT_HOME}/.pi/agent"}
JSON
echo '{}' > "$ABSENT_HOME/.pi/agent/auth.json"
# NO models.json here — intentional.
mkdir -p "$ABSENT_HOME/.hermes"
cat > "$ABSENT_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$ABSENT_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON

ABSENT_REAL="$ABSENT_VAR/home"
if HOME="$ABSENT_HOME" TT_OPERATOR_HOME="$ABSENT_HOME" TT_VAR="$ABSENT_VAR" \
    DEEPSEEK_API_KEY="sk-test-deepseek" \
    "$TOOL" >/tmp/tt-provision-absent.log 2>&1; then
  pass "models.json-absent run exits 0"
else
  fail "models.json-absent run did NOT exit 0"
  cat /tmp/tt-provision-absent.log >&2
fi

if [ -f "$ABSENT_REAL/.pi/agent/settings.json" ]; then
  pass "settings.json surfaced with models.json absent"
else
  fail "settings.json NOT surfaced with models.json absent"
fi

if [ ! -e "$ABSENT_REAL/.pi/agent/models.json" ]; then
  pass "models.json NOT surfaced (absent operator file skipped)"
else
  fail "models.json WAS surfaced — should have been skipped"
fi

if ! grep -q "missing surfaced file(s)" /tmp/tt-provision-absent.log && ! grep -q "copy-missing" /tmp/tt-provision-absent.log; then
  pass "models.json not named missing in provisioning output"
else
  fail "models.json named missing in provisioning output"
fi

# ── Test 12: hermes-dotenv enumerated fallback (CRED-SURF US-001) ─────
echo ""
echo "--- Test: hermes-dotenv fallback (fixture operator HOME) ---"

# Every enumerated PI_ENV_API_KEY_MAP key, unset from the invoking env so the
# fallback is deterministic regardless of the operator's real environment.
# Derived from the tool's own map (never hand-maintained here).
UNSET_ARGS=()
UNSET_KEYS=0
while IFS= read -r ev; do
  if [ -n "$ev" ]; then
    UNSET_ARGS+=(-u "$ev")
    UNSET_KEYS=$((UNSET_KEYS + 1))
  fi
done < <(grep -oE '"[A-Z0-9_]+\|[a-z0-9-]+"' "$TOOL" | sed 's/"//g; s/|.*//' | sort -u)
if [ "$UNSET_KEYS" -ge 19 ]; then
  pass "derived $UNSET_KEYS enumerated keys to unset"
else
  fail "expected >=19 enumerated keys, derived $UNSET_KEYS"
fi

# Fixture operator HOME with a fake ~/.hermes/.env: one enumerated key
# (DEEPSEEK_API_KEY, plain), one enumerated key with a QUOTED value
# (OPENAI_API_KEY), one non-enumerated line (OTHER), and a comment — only the
# two enumerated lines may ever be materialized.
mkdir -p "$FIX_HOME/.pi/agent" "$FIX_HOME/.hermes"
cat > "$FIX_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek","agentDir":"${FIX_HOME}/.pi/agent"}
JSON
echo '{}' > "$FIX_HOME/.pi/agent/auth.json"
cat > "$FIX_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$FIX_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON
cat > "$FIX_HOME/.hermes/.env" <<'ENV'
# operator comment — must never be copied
DEEPSEEK_API_KEY=sk-test-dotenv-deepseek
OTHER=sk-test-non-enumerated
OPENAI_API_KEY="sk-test-dotenv-openai-quoted"
ENV

FIX_REAL="$FIX_VAR/home"
if HOME="$FIX_HOME" TT_OPERATOR_HOME="$FIX_HOME" TT_VAR="$FIX_VAR" \
    env ${UNSET_ARGS[@]+"${UNSET_ARGS[@]}"} "$TOOL" >/tmp/tt-dotenv.log 2>&1; then
  pass "hermes-dotenv fallback run exits 0"
else
  fail "hermes-dotenv fallback run did NOT exit 0"
  cat /tmp/tt-dotenv.log >&2
fi

# (a) contained hermes .env gains the enumerated dotenv keys (unquoted).
if grep -q '^DEEPSEEK_API_KEY=sk-test-dotenv-deepseek$' "$FIX_REAL/.hermes/.env"; then
  pass "hermes .env gained DEEPSEEK_API_KEY from hermes-dotenv"
else
  fail "hermes .env missing dotenv DEEPSEEK_API_KEY: $(cat "$FIX_REAL/.hermes/.env")"
fi
if grep -q '^OPENAI_API_KEY=sk-test-dotenv-openai-quoted$' "$FIX_REAL/.hermes/.env"; then
  pass "hermes .env gained OPENAI_API_KEY from hermes-dotenv (quotes stripped)"
else
  fail "hermes .env missing dotenv OPENAI_API_KEY"
fi

# (a) pi auth.json gains the deepseek provider with the dotenv value.
if grep -q '"deepseek"' "$FIX_REAL/.pi/agent/auth.json" && grep -q 'sk-test-dotenv-deepseek' "$FIX_REAL/.pi/agent/auth.json"; then
  pass "pi auth.json gained deepseek provider from hermes-dotenv"
else
  fail "pi auth.json missing dotenv deepseek provider: $(cat "$FIX_REAL/.pi/agent/auth.json")"
fi

# (a) audit records source=hermes-dotenv for the fallback keys.
if grep -q '^{"key":"DEEPSEEK_API_KEY","provider":"deepseek","source":"hermes-dotenv"}' "$FIX_REAL/provision-audit.json"; then
  pass "audit records DEEPSEEK_API_KEY source=hermes-dotenv"
else
  fail "audit missing hermes-dotenv source for DEEPSEEK_API_KEY"
fi
if grep -q '^{"key":"OPENAI_API_KEY","provider":"openai","source":"hermes-dotenv"}' "$FIX_REAL/provision-audit.json"; then
  pass "audit records OPENAI_API_KEY source=hermes-dotenv"
else
  fail "audit missing hermes-dotenv source for OPENAI_API_KEY"
fi

# (d) non-enumerated lines + comments are NEVER copied — the contained .env is
# byte-exact against the enumerated-only expected content (map order: OPENAI
# precedes DEEPSEEK in PI_ENV_API_KEY_MAP).
printf 'OPENAI_API_KEY=sk-test-dotenv-openai-quoted\nDEEPSEEK_API_KEY=sk-test-dotenv-deepseek\n' > /tmp/tt-env-expected
if cmp -s /tmp/tt-env-expected "$FIX_REAL/.hermes/.env"; then
  pass "contained hermes .env is byte-exact (enumerated-only, map order)"
else
  fail "contained hermes .env NOT byte-exact: $(cat "$FIX_REAL/.hermes/.env")"
fi
if grep -q 'OTHER' "$FIX_REAL/.hermes/.env"; then
  fail "non-enumerated OTHER line WAS copied"
else
  pass "non-enumerated OTHER line NOT copied"
fi
if grep -q '^#' "$FIX_REAL/.hermes/.env"; then
  fail "comment line WAS copied"
else
  pass "comment line NOT copied"
fi
if grep -rq 'sk-test-non-enumerated' "$FIX_REAL" 2>/dev/null; then
  fail "non-enumerated value leaked into the contained home"
else
  pass "non-enumerated value absent from the contained home"
fi

# Key VALUES must never appear in the audit JSON (hygiene).
if grep -q 'sk-test-dotenv-deepseek\|sk-test-dotenv-openai-quoted' "$FIX_REAL/provision-audit.json"; then
  fail "key VALUES leaked into audit JSON"
else
  pass "audit JSON contains no key values"
fi

# (AC4) audit names EVERY enumerated key with a source (no silent skip).
AUDIT_MISSING=0
while IFS= read -r ev; do
  [ -n "$ev" ] || continue
  if grep -q "^{\"key\":\"${ev}\"" "$FIX_REAL/provision-audit.json"; then
    pass "audit names ${ev}"
  else
    fail "audit missing ${ev}"
    AUDIT_MISSING=1
  fi
done < <(grep -oE '"[A-Z0-9_]+\|[a-z0-9-]+"' "$TOOL" | sed 's/"//g; s/|.*//' | sort -u)
[ "$AUDIT_MISSING" -eq 0 ] && pass "audit names EVERY enumerated key" || fail "audit silently skipped at least one key"

# (AC5) idempotency: a second run leaves the contained home byte-identical.
FIX_SNAP_BEFORE="$(find "$FIX_REAL" -type f -exec sha256sum {} \; | sort | sha256sum)"
if HOME="$FIX_HOME" TT_OPERATOR_HOME="$FIX_HOME" TT_VAR="$FIX_VAR" \
    env ${UNSET_ARGS[@]+"${UNSET_ARGS[@]}"} "$TOOL" >/tmp/tt-dotenv-2.log 2>&1; then
  pass "hermes-dotenv second run exits 0"
else
  fail "hermes-dotenv second run did NOT exit 0"
fi
FIX_SNAP_AFTER="$(find "$FIX_REAL" -type f -exec sha256sum {} \; | sort | sha256sum)"
if [ "$FIX_SNAP_BEFORE" = "$FIX_SNAP_AFTER" ]; then
  pass "dotenv-fallback run idempotent (byte-identical after second run)"
else
  fail "dotenv-fallback run CHANGED the contained home on second run"
fi

# ── Test 13: env wins over hermes-dotenv (CRED-SURF red-arm c) ────────
echo ""
echo "--- Test: env wins over hermes-dotenv ---"

FIX_REAL2="$FIX_VAR2/home"
if HOME="$FIX_HOME" TT_OPERATOR_HOME="$FIX_HOME" TT_VAR="$FIX_VAR2" \
    env ${UNSET_ARGS[@]+"${UNSET_ARGS[@]}"} DEEPSEEK_API_KEY="sk-test-env-deepseek" "$TOOL" >/tmp/tt-envwins.log 2>&1; then
  pass "env-wins run exits 0"
else
  fail "env-wins run did NOT exit 0"
  cat /tmp/tt-envwins.log >&2
fi

if grep -q '^DEEPSEEK_API_KEY=sk-test-env-deepseek$' "$FIX_REAL2/.hermes/.env"; then
  pass "env value wins in hermes .env (env over hermes-dotenv)"
else
  fail "hermes .env missing the env value: $(cat "$FIX_REAL2/.hermes/.env")"
fi
if grep -q 'sk-test-dotenv-deepseek' "$FIX_REAL2/.hermes/.env"; then
  fail "dotenv value leaked into hermes .env despite env being set"
else
  pass "dotenv value NOT used when env is set"
fi
if grep -q '^{"key":"DEEPSEEK_API_KEY","provider":"deepseek","source":"env"}' "$FIX_REAL2/provision-audit.json"; then
  pass "audit records DEEPSEEK_API_KEY source=env (env wins)"
else
  fail "audit missing source=env for DEEPSEEK_API_KEY"
fi

# ── Test 14: env unset + .env absent → audit source=absent (CRED-SURF b) ─
echo ""
echo "--- Test: absent source recorded (no silent skip) ---"

mkdir -p "$NOENV_HOME/.pi/agent" "$NOENV_HOME/.hermes"
cat > "$NOENV_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek","agentDir":"${NOENV_HOME}/.pi/agent"}
JSON
echo '{}' > "$NOENV_HOME/.pi/agent/auth.json"
cat > "$NOENV_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$NOENV_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON
# NO ~/.hermes/.env — intentional.

if HOME="$NOENV_HOME" TT_OPERATOR_HOME="$NOENV_HOME" TT_VAR="$NOENV_VAR" \
    env ${UNSET_ARGS[@]+"${UNSET_ARGS[@]}"} "$TOOL" >/tmp/tt-absent.log 2>&1; then
  pass "absent-.env run exits 0"
else
  fail "absent-.env run did NOT exit 0"
  cat /tmp/tt-absent.log >&2
fi
if grep -q '^{"key":"DEEPSEEK_API_KEY","provider":"deepseek","source":"absent"}' "$NOENV_VAR/home/provision-audit.json"; then
  pass "audit records DEEPSEEK_API_KEY source=absent (no silent skip)"
else
  fail "audit missing source=absent for DEEPSEEK_API_KEY"
fi
if grep -q '^DEEPSEEK_API_KEY=' "$NOENV_VAR/home/.hermes/.env" 2>/dev/null; then
  fail "DEEPSEEK_API_KEY written despite absent source"
else
  pass "no DEEPSEEK_API_KEY line in contained .env when source absent"
fi

# ── Test 15: --help documents the hermes-dotenv fallback ───────────────
echo ""
echo "--- Test: --help documents the hermes-dotenv fallback ---"

if "$TOOL" --help | grep -q "hermes-dotenv"; then
  pass "--help documents the hermes-dotenv fallback"
else
  fail "--help does not document the hermes-dotenv fallback"
fi
if "$TOOL" --help | grep -q 'env|hermes-dotenv|absent'; then
  pass "--help documents the audit source values env|hermes-dotenv|absent"
else
  fail "--help does not document the audit source values"
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
