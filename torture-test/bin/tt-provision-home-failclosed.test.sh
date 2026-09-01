#!/usr/bin/env bash
# tt-provision-home-failclosed.test.sh — self-test for the E2.5 US-001
# fail-closed provisioning mode of tt-provision-home (--fail-closed).
#
# Proves the spec-01 / E2.5 contract:
#   AC1  a fail-closed REAL-home provisioning helper exists and runs under the
#        contained env semantics (resolves via env/tt-env.sh when TT_VAR unset)
#   AC2  with torture-test/var/home absent it provisions the contained home
#        (dirs + .gitconfig) under torture-test/var WITHOUT touching the
#        operator's real ~/.tamandua or ~/.gitconfig (or the 33xx daemon)
#   AC3  running it twice is a no-op (idempotent; second run exits 0, no churn)
#   AC4  forcing a failure leg makes it exit non-zero and emit the DISTINCT
#        machine-parseable reason string tt-home-unprovisioned
#   AC5/AC6  tests + typecheck (build) remain green
#
# Confined entirely to temp dirs under ${TMPDIR:-/tmp} + gitignored
# torture-test/var. The operator's real ~/.gitconfig is only ever READ.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-provision-home"

FAILURES=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-provision-home --fail-closed self-test ==="

# ── Setup: mock operator HOME and isolated TT_VAR ─────────────────────
MOCK_HOME="$(mktemp -d)"
TEST_VAR="$(mktemp -d)"
MODELS_ABSENT_HOME="$(mktemp -d)"
MODELS_ABSENT_VAR="$(mktemp -d)"
SETTINGS_ABSENT_HOME="$(mktemp -d)"
SETTINGS_ABSENT_VAR="$(mktemp -d)"
AUTH_ABSENT_HOME="$(mktemp -d)"
AUTH_ABSENT_VAR="$(mktemp -d)"

cleanup() {
  rm -rf "$MOCK_HOME" "$TEST_VAR" \
    "$MODELS_ABSENT_HOME" "$MODELS_ABSENT_VAR" \
    "$SETTINGS_ABSENT_HOME" "$SETTINGS_ABSENT_VAR" \
    "$AUTH_ABSENT_HOME" "$AUTH_ABSENT_VAR"
}
trap cleanup EXIT

# Mock operator harness config so the minimal-file copy legs can be exercised
# (E2.6 US-004: enumerated files only — no whole-dir copy).
mkdir -p "$MOCK_HOME/.pi/agent"
cat > "$MOCK_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek","agentDir":"${MOCK_HOME}/.pi/agent"}
JSON
cat > "$MOCK_HOME/.pi/agent/models.json" <<JSON
{"providers":{}}
JSON
echo '{}' > "$MOCK_HOME/.pi/agent/auth.json"
mkdir -p "$MOCK_HOME/.hermes"
cat > "$MOCK_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$MOCK_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON

# run against the isolated env (TT_OPERATOR_HOME pins the copy source; the
# contained spawn env would otherwise override HOME, which is the E2.6 bug).
run_fc() {
  HOME="$MOCK_HOME" TT_OPERATOR_HOME="$MOCK_HOME" TT_VAR="$TEST_VAR" "$TOOL" --fail-closed "$@"
}

REAL_TT_HOME="$TEST_VAR/home"

# ── AC1: --help documents --fail-closed ───────────────────────────────
if "$TOOL" --help | grep -q -- "--fail-closed"; then
  pass "--help documents --fail-closed"
else
  fail "--help does not document --fail-closed"
fi

# ── AC2: absent home → provisioned contained home, operator untouched ─
echo ""
echo "--- AC2: provision contained home when absent ---"

if run_fc >/tmp/tt-fc-1.log 2>&1; then
  pass "first --fail-closed run exits 0"
else
  fail "first --fail-closed run did NOT exit 0 (log below)"
  cat /tmp/tt-fc-1.log >&2
fi

if [ -d "$REAL_TT_HOME" ]; then
  pass "contained TT home directory created under TT_VAR"
else
  fail "contained TT home directory NOT created"
fi

if [ -f "$REAL_TT_HOME/.gitconfig" ]; then
  pass "contained .gitconfig created"
else
  fail "contained .gitconfig NOT created"
fi

# Identity fields present per spec 01.
name="$(git config -f "$REAL_TT_HOME/.gitconfig" --get user.name 2>/dev/null || true)"
if [ "$name" = "Tamandua Torture Test" ]; then
  pass "contained .gitconfig user.name set to TT identity"
else
  fail "contained .gitconfig user.name = '$name'"
fi

if [ -d "$REAL_TT_HOME/.pi/agent" ] && [ -d "$REAL_TT_HOME/.hermes" ]; then
  pass "~/.pi/agent and ~/.hermes created into contained home"
else
  fail "harness config directories missing from contained home"
fi

# Enumerated minimal files must be present (US-004 AC1).
for f in ".pi/agent/settings.json" ".pi/agent/models.json" ".pi/agent/auth.json" \
         ".hermes/config.yaml" ".hermes/auth.json"; do
  if [ -f "$REAL_TT_HOME/$f" ]; then
    pass "contained $f surfaced"
  else
    fail "contained $f NOT surfaced"
  fi
done

# Operator-real files must be untouched (only read). We assert the mock HOME
# did not gain a .gitconfig or .tamandua (the contained run must not write to
# the operator home).
if [ ! -f "$MOCK_HOME/.gitconfig" ]; then
  pass "operator mock HOME not given a .gitconfig (writes stayed contained)"
else
  fail "operator mock HOME gained a .gitconfig — containment breach"
fi
if [ ! -e "$MOCK_HOME/.tamandua" ]; then
  pass "operator mock ~/.tamandua not created"
else
  fail "operator mock ~/.tamandua was created — containment breach"
fi

# ── AC2 containment: home resolves under torture-test/var when TT_VAR unset ─
echo ""
echo "--- AC2 (env resolution): unset TT_VAR resolves contained TT_HOME ---"
if TT_VAR="" HOME="$MOCK_HOME" TT_OPERATOR_HOME="$MOCK_HOME" "$TOOL" --fail-closed \
    | grep -q "contained TT home provisioned at "; then
  pass "--fail-closed with TT_VAR unset targets the contained env path"
else
  fail "--fail-closed with TT_VAR unset did not report a contained home"
fi

# The resolved home must live under torture-test/var (the contained location),
# NOT under the operator's home.
RESOLVED="$(TT_VAR="" HOME="$MOCK_HOME" TT_OPERATOR_HOME="$MOCK_HOME" "$TOOL" --fail-closed 2>/dev/null | grep 'contained TT home provisioned at' | sed 's/.*at //')"
case "$RESOLVED" in
  */torture-test/var/home) pass "--fail-closed resolved the contained TT_HOME (torture-test/var/home)" ;;
  *) fail "--fail-closed resolved an unexpected home: '$RESOLVED'" ;;
esac

# ── AC3: idempotency — second run exit 0, no churn ────────────────────
echo ""
echo "--- AC3: idempotency ---"

GCFG_BEFORE="$(sha256sum "$REAL_TT_HOME/.gitconfig" | awk '{print $1}')"
PI_BEFORE="$(sha256sum "$REAL_TT_HOME/.pi/agent/settings.json" | awk '{print $1}')"

if run_fc >/tmp/tt-fc-2.log 2>&1; then
  pass "second --fail-closed run exits 0"
else
  fail "second --fail-closed run did NOT exit 0"
fi

GCFG_AFTER="$(sha256sum "$REAL_TT_HOME/.gitconfig" | awk '{print $1}')"
PI_AFTER="$(sha256sum "$REAL_TT_HOME/.pi/agent/settings.json" | awk '{print $1}')"

if [ "$GCFG_BEFORE" = "$GCFG_AFTER" ]; then
  pass ".gitconfig unchanged after second run (idempotent, no churn)"
else
  fail ".gitconfig CHANGED on second run (churn)"
fi
if [ "$PI_BEFORE" = "$PI_AFTER" ]; then
  pass ".pi/agent/settings.json unchanged after second run (idempotent)"
else
  fail ".pi/agent/settings.json CHANGED on second run"
fi

# ── AC4: forcing a failure leg → REASON tt-home-unprovisioned, exit≠0 ─
echo ""
echo "--- AC4: fail-closed on a broken leg ---"

# Break the .gitconfig identity (provisioning left it incomplete). Because the
# base tool skips an existing .gitconfig, this simulates an incomplete/stale
# provisioning defect that the verification legs must catch.
cat > "$REAL_TT_HOME/.gitconfig" <<'EOF'
[user]
    name = Someone Else
    email = someone@else.test
EOF

set +e
run_fc >/tmp/tt-fc-3.log 2>/tmp/tt-fc-3.err
FC_STATUS=$?
set -e

if [ "$FC_STATUS" -ne 0 ]; then
  pass "broken-leg run exits non-zero ($FC_STATUS)"
else
  fail "broken-leg run exited 0 (should fail closed)"
fi

if grep -q "REASON: tt-home-unprovisioned" /tmp/tt-fc-3.err; then
  pass "emits distinct machine-parseable reason tt-home-unprovisioned"
else
  fail "missing REASON: tt-home-unprovisioned on stderr:"
  cat /tmp/tt-fc-3.err >&2
fi

# ── AC4b: a genuinely missing home dir also fails closed ──────────────
echo ""
echo "--- AC4b: missing home dir leg fails closed ---"

# Point TT_VAR at a fresh dir and pre-place a FILE (not a dir) where the home
# directory must be created — mkdir cannot make a directory over a file, so
# the contained home can never be established.
mkdir -p "$TEST_VAR/blocked"
touch "$TEST_VAR/blocked/home"
chmod 400 "$TEST_VAR/blocked/home"

set +e
HOME="$MOCK_HOME" TT_OPERATOR_HOME="$MOCK_HOME" TT_VAR="$TEST_VAR/blocked" "$TOOL" --fail-closed \
  >/tmp/tt-fc-4.log 2>/tmp/tt-fc-4.err
FC4_STATUS=$?
set -e

if [ "$FC4_STATUS" -ne 0 ]; then
  pass "blocked-home leg exits non-zero ($FC4_STATUS)"
else
  fail "blocked-home leg exited 0 (should fail closed)"
fi
if grep -q "REASON: tt-home-unprovisioned" /tmp/tt-fc-4.err; then
  pass "blocked-home leg emits distinct reason tt-home-unprovisioned"
else
  fail "blocked-home leg missing REASON on stderr:"
  cat /tmp/tt-fc-4.err >&2
fi

# ── AC4c (MACP8 US-001): models.json absent → --fail-closed succeeds ──
echo ""
echo "--- AC4c: models.json-absent operator home (darwin shape) ---"

mkdir -p "$MODELS_ABSENT_HOME/.pi/agent"
cat > "$MODELS_ABSENT_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek"}
JSON
echo '{}' > "$MODELS_ABSENT_HOME/.pi/agent/auth.json"
# NO models.json — intentional darwin operator shape.
mkdir -p "$MODELS_ABSENT_HOME/.hermes"
cat > "$MODELS_ABSENT_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$MODELS_ABSENT_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON

set +e
HOME="$MODELS_ABSENT_HOME" TT_OPERATOR_HOME="$MODELS_ABSENT_HOME" TT_VAR="$MODELS_ABSENT_VAR" \
  "$TOOL" --fail-closed >/tmp/tt-fc-models-absent.log 2>/tmp/tt-fc-models-absent.err
MA_STATUS=$?
set -e

if [ "$MA_STATUS" -eq 0 ]; then
  pass "models.json-absent --fail-closed exits 0"
else
  fail "models.json-absent --fail-closed exited non-zero ($MA_STATUS)"
  cat /tmp/tt-fc-models-absent.err >&2
fi

if [ ! -e "$MODELS_ABSENT_VAR/home/.pi/agent/models.json" ]; then
  pass "models.json NOT surfaced (absent operator file skipped)"
else
  fail "models.json WAS surfaced — should have been skipped"
fi

if grep -q "copy-missing:.pi/agent/models.json" /tmp/tt-fc-models-absent.err; then
  fail "models.json named copy-missing in --fail-closed output"
else
  pass "models.json not named copy-missing in --fail-closed output"
fi

# ── AC4d (MACP8 US-001): settings.json absent → required fail-closed ──
echo ""
echo "--- AC4d: settings.json-absent operator home fails closed ---"

mkdir -p "$SETTINGS_ABSENT_HOME/.pi/agent"
# NO settings.json — required file absent.
echo '{}' > "$SETTINGS_ABSENT_HOME/.pi/agent/auth.json"
mkdir -p "$SETTINGS_ABSENT_HOME/.hermes"
cat > "$SETTINGS_ABSENT_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$SETTINGS_ABSENT_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON

set +e
HOME="$SETTINGS_ABSENT_HOME" TT_OPERATOR_HOME="$SETTINGS_ABSENT_HOME" TT_VAR="$SETTINGS_ABSENT_VAR" \
  "$TOOL" --fail-closed >/tmp/tt-fc-settings-absent.log 2>/tmp/tt-fc-settings-absent.err
SA_STATUS=$?
set -e

if [ "$SA_STATUS" -ne 0 ]; then
  pass "settings.json-absent --fail-closed exits non-zero ($SA_STATUS)"
else
  fail "settings.json-absent --fail-closed exited 0 (should fail closed)"
fi

if grep -q "REASON: tt-home-unprovisioned" /tmp/tt-fc-settings-absent.err; then
  pass "settings.json-absent emits REASON: tt-home-unprovisioned"
else
  fail "settings.json-absent missing REASON on stderr"
  cat /tmp/tt-fc-settings-absent.err >&2
fi

if grep -q "copy-missing:.pi/agent/settings.json" /tmp/tt-fc-settings-absent.err; then
  pass "settings.json-absent DETAILS names copy-missing:.pi/agent/settings.json"
else
  fail "settings.json-absent DETAILS missing copy-missing:.pi/agent/settings.json"
  cat /tmp/tt-fc-settings-absent.err >&2
fi

# ── AC4e (MACP8 US-001): auth.json absent → required fail-closed ──────
echo ""
echo "--- AC4e: auth.json-absent operator home fails closed ---"

mkdir -p "$AUTH_ABSENT_HOME/.pi/agent"
cat > "$AUTH_ABSENT_HOME/.pi/agent/settings.json" <<JSON
{"defaultProvider":"deepseek"}
JSON
# NO auth.json — required file absent.
mkdir -p "$AUTH_ABSENT_HOME/.hermes"
cat > "$AUTH_ABSENT_HOME/.hermes/config.yaml" <<YAML
model:
  default: gpt-5.6-sol
YAML
cat > "$AUTH_ABSENT_HOME/.hermes/auth.json" <<JSON
{"version":1}
JSON

set +e
HOME="$AUTH_ABSENT_HOME" TT_OPERATOR_HOME="$AUTH_ABSENT_HOME" TT_VAR="$AUTH_ABSENT_VAR" \
  "$TOOL" --fail-closed >/tmp/tt-fc-auth-absent.log 2>/tmp/tt-fc-auth-absent.err
AA_STATUS=$?
set -e

if [ "$AA_STATUS" -ne 0 ]; then
  pass "auth.json-absent --fail-closed exits non-zero ($AA_STATUS)"
else
  fail "auth.json-absent --fail-closed exited 0 (should fail closed)"
fi

if grep -q "copy-missing:.pi/agent/auth.json" /tmp/tt-fc-auth-absent.err; then
  pass "auth.json-absent DETAILS names copy-missing:.pi/agent/auth.json"
else
  fail "auth.json-absent DETAILS missing copy-missing:.pi/agent/auth.json"
  cat /tmp/tt-fc-auth-absent.err >&2
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
