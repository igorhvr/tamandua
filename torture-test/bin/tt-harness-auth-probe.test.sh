#!/usr/bin/env bash
# tt-harness-auth-probe.test.sh — self-test for tt-harness-auth-probe.
#
# Validates E2.6 US-005 acceptance criteria:
#   AC1  probe pi exits 0 against a contained home with surfaced pi auth and
#        emits no error (no REASON:/Error text).
#   AC2  pi auth stripped → non-zero exit + `harness-auth-missing: pi` on stderr.
#   AC3  hermes auth stripped → non-zero + `harness-auth-missing: hermes`.
#   AC4  near-zero tokens (no full generation: single --no-tools one-shot) and
#        does NOT start the real daemon.
#   AC5  resolves required harnesses from the manifest (only pi for a pi-only
#        selection).
#   AC6  (this file).
#
# Plus CRED-SURF US-002 credential-source reporting + fail-closed missing-key
# naming (red-arm, fixture operator HOME via TT_OPERATOR_HOME, zero tokens):
#   AC1  OK line reports `credential source: env` when the primary key is in
#        the invoking env.
#   AC2  OK line reports `credential source: hermes-dotenv` when the key is
#        absent from env but present in the fixture operator ~/.hermes/.env.
#   AC3  env unset + fixture .env absent → fail-closed `harness-auth-missing:
#        <harness>` with DETAILS NAMING the missing key (no silent skip).
#   AC4  existing fail-closed reasons unchanged; probe stays read-only +
#        idempotent; key VALUES never appear in probe output; --help documents
#        the credential-source reporting.
#
# Plus CRED-SURF US-004 real dsh answer leg behind --spend (red-arm e, zero
# tokens — fake dsh binaries only):
#   AC1  `--spend dsh` against a fake dsh exiting non-zero with a
#        MISSING_CREDENTIAL-shaped stderr → probe exits non-zero with
#        `harness-auth-missing: dsh` (DETAILS name the credential).
#   AC2  `--spend dsh` against an answering fake (exit 0) → probe exits 0
#        with an OK line carrying the credential source.
#   AC3  without --spend, dsh stays presence-only: the fake dsh binary is NOT
#        invoked and the log reports alpha-skipped (unchanged behavior).
#   AC4  the dsh --spend invocation carries the sentinel prompt +
#        `--profile headless` (a real answer leg, not --dump-default-config);
#        DEEPSEEK_API_KEY resolved from the enumerated sources (env ->
#        fixture operator ~/.hermes/.env) is exported into the invocation env
#        (env-only transport — the VALUE never appears in argv/logs/output).
#   AC5  pi/hermes answer legs are unaffected (always run, as today).
#   AC6  `tt-harness-auth-probe --help` documents the real dsh --spend
#        answer leg.
#
# All harness invocations use FAKE pi/hermes/dsh binaries (seams
# TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY / TAMANDUA_DSH_BINARY), so this
# self-test spends ZERO real tokens and starts no daemon. Confined to temp
# dirs under ${TMPDIR:-/tmp} — never operator state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-harness-auth-probe"

FAILURES=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-harness-auth-probe self-test ==="

# ── Test 1: --help documents the tool + fail-closed reasons ────────────
echo ""
echo "--- Test: --help ---"
if "$TOOL" --help | grep -q "Usage:"; then
  pass "--help prints usage"
else
  fail "--help did not print usage"
fi
if "$TOOL" --help | grep -q "harness-auth-missing: pi" && "$TOOL" --help | grep -q "harness-auth-missing: hermes"; then
  pass "--help documents both distinct fail-closed reasons"
else
  fail "--help does not document both distinct fail-closed reasons"
fi
if "$TOOL" --help | grep -q "TAMANDUA_PI_BINARY" && "$TOOL" --help | grep -q "TT_CASES_DIR"; then
  pass "--help documents the binary + cases-dir seams"
else
  fail "--help does not document the binary / cases-dir seams"
fi
if "$TOOL" --help > /dev/null 2>&1; then
  pass "--help exits 0"
else
  fail "--help did not exit 0"
fi

# ── Setup: temp contained home + fake harness binaries ────────────────
echo ""
echo "--- Setup ---"

TEST_VAR="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
INVOC_LOG="$(mktemp)"
cleanup() { rm -rf "$TEST_VAR" "$FAKE_BIN" "$INVOC_LOG"; }
trap cleanup EXIT

HOME_PI="$TEST_VAR/home/.pi/agent"
HOME_HERMES="$TEST_VAR/home/.hermes"
mkdir -p "$HOME_PI" "$HOME_HERMES"

provision_surfaced_auth() {
  mkdir -p "$HOME_PI" "$HOME_HERMES"
  printf '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-pro"}' > "$HOME_PI/settings.json"
  printf '{"providers":{"local-dspark":{"baseUrl":"http://localhost:1/v1","apiKey":"local"}}}' > "$HOME_PI/models.json"
  printf '{"deepseek":{"type":"api_key","key":"sk-test-deepseek"}}' > "$HOME_PI/auth.json"
  printf 'model:\n  default: gpt-5.6-sol\n  provider: openai-codex\n' > "$HOME_HERMES/config.yaml"
  printf '{"providers":{"openai-codex":{"tokens":{"id_token":"jwt-test"}}}}' > "$HOME_HERMES/auth.json"
}

# fake-pi / fake-hermes record their basename + full argv to INVOC_LOG and
# exit with a code baked into the script at write time (NOT via env, since the
# probe invokes the harness under `env -i`). A stderr message (e.g. pi's
# `No API key found`) is also baked in for the failure fixtures.
make_fake_harness() {
  local name="$1" exit_code="$2" stderr_msg="${3:-}"
  cat > "$FAKE_BIN/$name" <<FAKE
#!/usr/bin/env bash
if [ -n "$stderr_msg" ]; then printf '%s\n' "$stderr_msg" >&2; fi
printf '%s\n' "\$(basename "\$0") \$*" >> "$INVOC_LOG"
exit $exit_code
FAKE
  chmod +x "$FAKE_BIN/$name"
}
# make_fake_harness_env_mark: like make_fake_harness, plus a DEEPSEEK_API_KEY
# env-marker line appended to INVOC_LOG (SET/UNSET) so red-arm tests can prove
# the probe exports the resolved credential into the dsh invocation env
# WITHOUT the fake ever printing the key VALUE (US-004).
make_fake_harness_env_mark() {
  local name="$1" exit_code="$2" stderr_msg="${3:-}"
  cat > "$FAKE_BIN/$name" <<FAKE
#!/usr/bin/env bash
if [ -n "$stderr_msg" ]; then printf '%s\n' "$stderr_msg" >&2; fi
printf '%s\n' "\$(basename "\$0") \$*" >> "$INVOC_LOG"
if [ -n "\${DEEPSEEK_API_KEY:-}" ]; then
  printf 'DEEPSEEK_API_KEY=SET\n' >> "$INVOC_LOG"
else
  printf 'DEEPSEEK_API_KEY=UNSET\n' >> "$INVOC_LOG"
fi
exit $exit_code
FAKE
  chmod +x "$FAKE_BIN/$name"
}
make_fake_harness fake-pi 0
make_fake_harness fake-hermes 0
make_fake_harness fake-pi-fail 1 'No API key found for deepseek.'

provision_surfaced_auth
pass "temp contained home + fake harness binaries created"

# ── Test 2 (AC1): pi exits 0 with surfaced auth, no error ──────────────
echo ""
echo "--- Test: AC1 pi positive ---"
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe pi exits 0 with surfaced auth"
else
  fail "probe pi did NOT exit 0 (rc=$RC): $OUT"
fi
if ! printf '%s' "$OUT" | grep -q "REASON:"; then
  pass "probe pi emits no error (no REASON: line)"
else
  fail "probe pi emitted an error line: $OUT"
fi
if [ -s "$INVOC_LOG" ]; then
  pass "probe invoked the fake pi binary"
else
  fail "probe did NOT invoke the fake pi binary"
fi

# ── Test 3 (AC4a): single one-shot, no full generation (--no-tools) ───
echo ""
echo "--- Test: AC4 no-full-generation invocation ---"
if [ "$(wc -l < "$INVOC_LOG")" -eq 1 ]; then
  pass "fake pi invoked exactly once (no daemon + round loop)"
else
  fail "fake pi invoked more than once: $(cat "$INVOC_LOG")"
fi
if grep -q -- "--no-tools" "$INVOC_LOG" && grep -q -- "--no-session" "$INVOC_LOG"; then
  pass "pi invocation carries --no-tools --no-session (no tool loop / no session)"
else
  fail "pi invocation missing --no-tools/--no-session: $(cat "$INVOC_LOG")"
fi
if grep -q "Reply with the single word OK" "$INVOC_LOG"; then
  pass "pi invocation uses the trivial sentinel prompt"
else
  fail "pi invocation missing the sentinel prompt: $(cat "$INVOC_LOG")"
fi

# ── Test 4 (AC2): pi auth stripped → fail closed ───────────────────────
echo ""
echo "--- Test: AC2 pi auth stripped ---"
provision_surfaced_auth
rm -f "$HOME_PI/auth.json"
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe pi exits non-zero when pi auth stripped"
else
  fail "probe pi did NOT exit non-zero when pi auth stripped"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: pi"; then
  pass "distinct reason 'harness-auth-missing: pi' on stderr"
else
  fail "missing distinct reason for stripped pi: $OUT"
fi

# ── Test 4b (MACP8): pi positive with models.json absent ────────────────
echo ""
echo "--- Test: MACP8 pi positive (settings+auth present, models.json absent) ---"
provision_surfaced_auth
rm -f "$HOME_PI/models.json"
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe pi exits 0 with settings.json+auth.json and NO models.json"
else
  fail "probe pi did NOT exit 0 without models.json (rc=$RC): $OUT"
fi
if ! printf '%s' "$OUT" | grep -q "missing surfaced file(s): .pi/agent/models.json"; then
  pass "probe pi does NOT name models.json missing"
else
  fail "probe pi named models.json missing: $OUT"
fi

# ── Test 4c (MACP8): pi fail-closed auth.json absent (models.json absent) ──
echo ""
echo "--- Test: MACP8 pi fail-closed (auth.json absent, models.json absent) ---"
provision_surfaced_auth
rm -f "$HOME_PI/auth.json" "$HOME_PI/models.json"
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe pi exits non-zero when auth.json absent (models.json absent)"
else
  fail "probe pi did NOT exit non-zero when auth.json absent: $OUT"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: pi"; then
  pass "distinct reason 'harness-auth-missing: pi'"
else
  fail "missing distinct reason for auth.json-absent pi: $OUT"
fi
if printf '%s' "$OUT" | grep -q "missing surfaced file(s): .pi/agent/auth.json"; then
  pass "DETAILS names .pi/agent/auth.json"
else
  fail "DETAILS does not name .pi/agent/auth.json: $OUT"
fi

# ── Test 4d (MACP8): pi fail-closed settings.json absent ─────────────────
echo ""
echo "--- Test: MACP8 pi fail-closed (settings.json absent) ---"
provision_surfaced_auth
rm -f "$HOME_PI/settings.json"
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe pi exits non-zero when settings.json absent"
else
  fail "probe pi did NOT exit non-zero when settings.json absent: $OUT"
fi
if printf '%s' "$OUT" | grep -q "missing surfaced file(s): .pi/agent/settings.json"; then
  pass "DETAILS names .pi/agent/settings.json"
else
  fail "DETAILS does not name .pi/agent/settings.json: $OUT"
fi

# ── Test 5 (AC3): hermes auth stripped → fail closed ───────────────────
echo ""
echo "--- Test: AC3 hermes auth stripped ---"
provision_surfaced_auth
rm -f "$HOME_HERMES/auth.json"
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" hermes 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe hermes exits non-zero when hermes auth stripped"
else
  fail "probe hermes did NOT exit non-zero when hermes auth stripped"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: hermes"; then
  pass "distinct reason 'harness-auth-missing: hermes' on stderr"
else
  fail "missing distinct reason for stripped hermes: $OUT"
fi

# ── Test 6: files present but harness cannot answer → fail closed ──────
echo ""
echo "--- Test: answer-check failure (files present, harness exits non-zero) ---"
provision_surfaced_auth
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi-fail" "$TOOL" pi 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe exits non-zero when the harness cannot answer"
else
  fail "probe did NOT exit non-zero when the harness cannot answer"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: pi"; then
  pass "answer-check failure reports 'harness-auth-missing: pi'"
else
  fail "answer-check failure missing distinct reason: $OUT"
fi

# ── Test 7: hermes positive (surfaced auth + fake hermes exit 0) ───────
echo ""
echo "--- Test: hermes positive ---"
provision_surfaced_auth
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" hermes 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe hermes exits 0 with surfaced auth"
else
  fail "probe hermes did NOT exit 0 (rc=$RC): $OUT"
fi
if grep -q -- "-z" "$INVOC_LOG"; then
  pass "hermes invocation uses the one-shot (-z) mode"
else
  fail "hermes invocation missing -z: $(cat "$INVOC_LOG")"
fi

# ── Test 8 (AC5): manifest-driven harness enumeration ──────────────────
echo ""
echo "--- Test: AC5 manifest enumeration (pi-only selection) ---"
CASES_DIR="$(mktemp -d)"
cleanup_cases() { rm -rf "$CASES_DIR"; }
trap 'cleanup_cases; cleanup' EXIT
for name in tier0.jsonl tier1.jsonl cases.jsonl smoke.jsonl; do
  printf '{"id":"pi-case","harness":"pi","workflow":"tt-shim-probe"}\n' > "$CASES_DIR/$name"
done
provision_surfaced_auth
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TT_CASES_DIR="$CASES_DIR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" --from-manifest 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "pi-only manifest probe exits 0"
else
  fail "pi-only manifest probe did NOT exit 0 (rc=$RC): $OUT"
fi
if grep -q "fake-pi" "$INVOC_LOG" && ! grep -q "fake-hermes" "$INVOC_LOG"; then
  pass "only pi is probed for a pi-only selection (hermes NOT invoked)"
else
  fail "pi-only selection invoked the wrong harness(es): $(cat "$INVOC_LOG")"
fi

# ── Test 9 (AC5b): full real manifests enumerate {pi, hermes} ──────────
echo ""
echo "--- Test: AC5 full-manifest enumeration (pi + hermes) ---"
FULL_CASES="$(mktemp -d)"
cleanup_full_cases() { rm -rf "$FULL_CASES"; }
trap 'cleanup_cases; cleanup_full_cases; cleanup' EXIT
for name in tier0.jsonl tier1.jsonl cases.jsonl smoke.jsonl; do
  cp "$SCRIPT_DIR/../cases/$name" "$FULL_CASES/$name"
done
provision_surfaced_auth
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TT_CASES_DIR="$FULL_CASES" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" --from-manifest 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "full-manifest probe exits 0"
else
  fail "full-manifest probe did NOT exit 0 (rc=$RC): $OUT"
fi
if grep -q "fake-pi" "$INVOC_LOG" && grep -q "fake-hermes" "$INVOC_LOG"; then
  pass "both pi and hermes are probed from the full manifest"
else
  fail "full-manifest enumeration did not probe both harnesses: $(cat "$INVOC_LOG")"
fi

# ── Test 10: fail closed on unreadable manifest ────────────────────────
echo ""
echo "--- Test: manifest-unreadable fail-closed ---"
EMPTY_CASES="$(mktemp -d)"
cleanup_empty_cases() { rm -rf "$EMPTY_CASES"; }
trap 'cleanup_cases; cleanup_full_cases; cleanup_empty_cases; cleanup' EXIT
# Only tier0.jsonl present → tier1.jsonl missing → manifest-unreadable.
printf '{"id":"x","harness":"pi"}\n' > "$EMPTY_CASES/tier0.jsonl"
set +e
OUT="$(TT_VAR="$TEST_VAR" TT_CASES_DIR="$EMPTY_CASES" "$TOOL" --from-manifest 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "unreadable manifest exits non-zero"
else
  fail "unreadable manifest did NOT exit non-zero"
fi
if printf '%s' "$OUT" | grep -q "manifest-unreadable: tier1.jsonl"; then
  pass "distinct 'manifest-unreadable: tier1.jsonl' reason"
else
  fail "missing manifest-unreadable reason: $OUT"
fi

# ── Test 11: fail closed on corrupt manifest line ──────────────────────
echo ""
echo "--- Test: manifest-invalid fail-closed ---"
CORRUPT_CASES="$(mktemp -d)"
cleanup_corrupt_cases() { rm -rf "$CORRUPT_CASES"; }
trap 'cleanup_cases; cleanup_full_cases; cleanup_empty_cases; cleanup_corrupt_cases; cleanup' EXIT
printf '{"id":"x","harness":"pi"}\nnot json\n' > "$CORRUPT_CASES/tier0.jsonl"
for name in tier1.jsonl cases.jsonl smoke.jsonl; do
  printf '{"id":"x","harness":"pi"}\n' > "$CORRUPT_CASES/$name"
done
set +e
OUT="$(TT_VAR="$TEST_VAR" TT_CASES_DIR="$CORRUPT_CASES" "$TOOL" --from-manifest 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "corrupt manifest exits non-zero"
else
  fail "corrupt manifest did NOT exit non-zero"
fi
if printf '%s' "$OUT" | grep -q "manifest-invalid: tier0.jsonl: line 2"; then
  pass "distinct 'manifest-invalid: tier0.jsonl: line 2' reason"
else
  fail "missing manifest-invalid reason: $OUT"
fi

# ── Test 12 (AC4b): probe never starts the real daemon ─────────────────
echo ""
echo "--- Test: no daemon start (grep-proof) ---"
if ! grep -q "tt-daemon-up\|daemon start\|tamandua daemon" "$TOOL"; then
  pass "probe source does not start the daemon"
else
  fail "probe source references a daemon start"
fi

# ── Test 13: idempotent (second run identical outcome, read-only) ──────
echo ""
echo "--- Test: idempotency ---"
provision_surfaced_auth
: > "$INVOC_LOG"
SNAP_BEFORE="$(find "$TEST_VAR/home" -type f -exec sha256sum {} \; | sort | sha256sum)"
TT_VAR="$TEST_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi >/dev/null 2>&1
SNAP_AFTER="$(find "$TEST_VAR/home" -type f -exec sha256sum {} \; | sort | sha256sum)"
if [ "$SNAP_BEFORE" = "$SNAP_AFTER" ]; then
  pass "probe is read-only (contained home unchanged)"
else
  fail "probe mutated the contained home"
fi

# ── Test 14: unknown argument → exit 2 ─────────────────────────────────
echo ""
echo "--- Test: unknown argument ---"
set +e
"$TOOL" bogus >/dev/null 2>&1
RC=$?
set -e
if [ "$RC" -eq 2 ]; then
  pass "unknown argument exits 2"
else
  fail "unknown argument did NOT exit 2 (rc=$RC)"
fi

# ── Test 15 (US-002): dsh PRESENCE leg — present binary, answer leg skipped ─
echo ""
echo "--- Test: US-002 dsh presence (present binary, answer leg alpha-skipped) ---"
make_fake_harness fake-dsh 0
: > "$INVOC_LOG"
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh" "$TOOL" dsh 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe dsh exits 0 with a present binary"
else
  fail "probe dsh did NOT exit 0 (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "alpha-skipped"; then
  pass "dsh answer leg is reported alpha-skipped without --spend"
else
  fail "dsh answer leg skip not reported: $OUT"
fi
if [ ! -s "$INVOC_LOG" ]; then
  pass "dsh answer leg does NOT invoke the binary without --spend (zero tokens)"
else
  fail "dsh binary was invoked without --spend: $(cat "$INVOC_LOG")"
fi

# ── Test 16 (US-002): dsh absent → fail closed harness-auth-missing: dsh ──
echo ""
echo "--- Test: US-002 dsh absence fails closed (harness-auth-missing: dsh) ---"
set +e
OUT="$(TT_VAR="$TEST_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/does-not-exist" "$TOOL" dsh 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe dsh exits non-zero when the binary is absent"
else
  fail "probe dsh did NOT exit non-zero when the binary is absent"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: dsh"; then
  pass "distinct reason 'harness-auth-missing: dsh' on stderr"
else
  fail "missing distinct reason for absent dsh: $OUT"
fi

# ── Test 17 (US-004): dsh --spend runs the REAL answer leg (env source) ──
echo ""
echo "--- Test: US-004 dsh --spend real answer leg (answering fake, env credential) ---"
make_fake_harness_env_mark fake-dsh-ok 0
: > "$INVOC_LOG"
OUT="$(DEEPSEEK_API_KEY=sk-test-env-dsh-000 TT_VAR="$TEST_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh-ok" "$TOOL" --spend dsh 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe dsh --spend exits 0 against an answering fake"
else
  fail "probe dsh --spend did NOT exit 0 (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "OK: dsh can answer"; then
  pass "dsh --spend OK line reported"
else
  fail "dsh --spend OK line missing: $OUT"
fi
if printf '%s' "$OUT" | grep -q "credential source: env"; then
  pass "dsh --spend OK line reports the credential source (env)"
else
  fail "dsh --spend OK line missing credential source: $OUT"
fi
if grep -q -- "--profile headless" "$INVOC_LOG"; then
  pass "dsh --spend answer leg invokes --profile headless"
else
  fail "dsh --spend answer leg did not invoke --profile headless: $(cat "$INVOC_LOG")"
fi
if grep -q "Reply with the single word OK and nothing else." "$INVOC_LOG"; then
  pass "dsh --spend answer leg carries the trivial sentinel prompt (real answer leg)"
else
  fail "dsh --spend answer leg missing sentinel prompt: $(cat "$INVOC_LOG")"
fi
if grep -q -- "--dump-default-config" "$INVOC_LOG"; then
  fail "dsh --spend answer leg still runs the old --dump-default-config self-check"
else
  pass "dsh --spend answer leg no longer runs --dump-default-config"
fi
if grep -q "DEEPSEEK_API_KEY=SET" "$INVOC_LOG"; then
  pass "resolved DEEPSEEK_API_KEY is exported into the dsh invocation env (env source)"
else
  fail "DEEPSEEK_API_KEY not exported into the dsh invocation env: $(cat "$INVOC_LOG")"
fi
if printf '%s' "$OUT" | grep -q "sk-test-env-dsh-000\|sk-test-dotenv"; then
  fail "key VALUE leaked into probe output: $OUT"
else
  pass "probe output contains no key values"
fi

# ── Test 18 (US-002): usage documents dsh, TAMANDUA_DSH_BINARY, --spend ──
echo ""
echo "--- Test: US-002 --help documents the dsh lane ---"
if "$TOOL" --help | grep -q "harness-auth-missing: dsh" && "$TOOL" --help | grep -q "TAMANDUA_DSH_BINARY" && "$TOOL" --help | grep -q -- "--spend"; then
  pass "--help documents dsh reason + TAMANDUA_DSH_BINARY + --spend"
else
  fail "--help does not document the dsh lane"
fi

# ── CRED-SURF US-002: credential-source reporting + fail-closed key naming ──
#
# Red-arm fixtures: a fixture OPERATOR home (TT_OPERATOR_HOME pin) with a fake
# ~/.hermes/.env, and contained homes whose default provider maps to an
# enumerated env var (pi: deepseek/openai; hermes: deepseek). All fake values
# are sk-test-* — zero real tokens.
echo ""
echo "--- Setup: CRED-SURF US-002 fixtures ---"

CRED_VAR="$(mktemp -d)"
CRED_VAR_OPENAI="$(mktemp -d)"
CRED_VAR_HERMES="$(mktemp -d)"
CRED_OP="$(mktemp -d)"          # fixture operator HOME WITH ~/.hermes/.env
CRED_OP_NOENV="$(mktemp -d)"    # fixture operator HOME WITHOUT ~/.hermes/.env
cleanup_cred() { rm -rf "$CRED_VAR" "$CRED_VAR_OPENAI" "$CRED_VAR_HERMES" "$CRED_OP" "$CRED_OP_NOENV"; }
trap 'cleanup_cred; cleanup_cases; cleanup_full_cases; cleanup_empty_cases; cleanup_corrupt_cases; cleanup' EXIT

# provision_cred_home: contained home whose pi default provider is deepseek and
# hermes default provider is openai-codex (the operator fixture shapes).
provision_cred_home() {
  local var="$1"
  mkdir -p "$var/home/.pi/agent" "$var/home/.hermes"
  printf '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-pro"}' > "$var/home/.pi/agent/settings.json"
  printf '{"deepseek":{"type":"api_key","key":"sk-test-contained-deepseek"}}' > "$var/home/.pi/agent/auth.json"
  printf 'model:\n  default: gpt-5.6-sol\n  provider: openai-codex\n' > "$var/home/.hermes/config.yaml"
  printf '{"version":1}' > "$var/home/.hermes/auth.json"
}
# provision_cred_home_openai: pi default provider openai (env var OPENAI_API_KEY).
provision_cred_home_openai() {
  local var="$1"
  provision_cred_home "$var"
  printf '{"defaultProvider":"openai","defaultModel":"gpt-5"}' > "$var/home/.pi/agent/settings.json"
  printf '{"openai":{"type":"api_key","key":"sk-test-contained-openai"}}' > "$var/home/.pi/agent/auth.json"
}
# provision_cred_home_hermes_deepseek: hermes default provider deepseek.
provision_cred_home_hermes_deepseek() {
  local var="$1"
  mkdir -p "$var/home/.hermes"
  printf 'model:\n  default: deepseek-v4-pro\n  provider: deepseek\n' > "$var/home/.hermes/config.yaml"
  printf '{"version":1}' > "$var/home/.hermes/auth.json"
}

mkdir -p "$CRED_OP/.hermes"
cat > "$CRED_OP/.hermes/.env" <<'ENV'
DEEPSEEK_API_KEY=sk-test-dotenv-deepseek-111
OPENAI_API_KEY=sk-test-dotenv-openai-222
OTHER=sk-test-non-enumerated
ENV

make_fake_harness fake-dsh-fail 1 'MISSING_CREDENTIAL: Provider deepseek is set in config.yaml but no API key was found'
make_fake_harness fake-hermes-fail 1 'no api key for provider'

pass "CRED-SURF US-002 fixtures created"

# ── CRED-SURF US-004: real dsh answer leg behind --spend (red-arm e) ──
#
# The dsh --spend answer leg is a REAL one-shot completion (`dsh --profile
# headless` + the sentinel prompt) with DEEPSEEK_API_KEY resolved from the
# enumerated sources (env -> fixture operator ~/.hermes/.env) exported into
# the invocation env. A MISSING_CREDENTIAL-shaped failure fails closed;
# without --spend the binary is never invoked (Test 15 above).
echo ""
echo "--- Setup: CRED-SURF US-004 dsh answer-leg fixtures ---"

make_fake_harness_env_mark fake-dsh-ok-dotenv 0
make_fake_harness_env_mark fake-dsh-missing 1 'MISSING_CREDENTIAL: Provider deepseek is set in config.yaml but no API key was found'

# ── Test 19b (US-004): hermes-dotenv credential exported into the dsh env ──
echo ""
echo "--- Test: US-004 dsh --spend exports the hermes-dotenv credential ---"
: > "$INVOC_LOG"
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh-ok-dotenv" "$TOOL" --spend dsh 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  pass "probe dsh --spend exits 0 (hermes-dotenv credential, answering fake)"
else
  fail "probe dsh --spend did NOT exit 0 (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "credential source: hermes-dotenv"; then
  pass "dsh --spend OK line reports 'credential source: hermes-dotenv'"
else
  fail "dsh --spend OK line missing hermes-dotenv source: $OUT"
fi
if grep -q "DEEPSEEK_API_KEY=SET" "$INVOC_LOG"; then
  pass "the hermes-dotenv credential is exported into the dsh invocation env"
else
  fail "hermes-dotenv credential NOT exported into the dsh invocation env: $(cat "$INVOC_LOG")"
fi
if grep -q "sk-test-dotenv-deepseek-111" "$INVOC_LOG" || printf '%s' "$OUT" | grep -q "sk-test-dotenv-deepseek-111"; then
  fail "key VALUE leaked into the invocation log / probe output"
else
  pass "no key VALUE in the invocation log or probe output (env-only transport)"
fi

# ── Test 19c (US-004 red-arm e / AC1): MISSING_CREDENTIAL → fail closed ──
echo ""
echo "--- Test: US-004 dsh --spend fails closed on MISSING_CREDENTIAL ---"
: > "$INVOC_LOG"
set +e
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP_NOENV" TT_VAR="$CRED_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh-missing" "$TOOL" --spend dsh 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe dsh --spend exits non-zero on a MISSING_CREDENTIAL-shaped failure"
else
  fail "probe dsh --spend did NOT exit non-zero on MISSING_CREDENTIAL: $OUT"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: dsh"; then
  pass "distinct reason 'harness-auth-missing: dsh' on MISSING_CREDENTIAL"
else
  fail "missing 'harness-auth-missing: dsh': $OUT"
fi
if printf '%s' "$OUT" | grep -q "MISSING_CREDENTIAL"; then
  pass "DETAILS carries the MISSING_CREDENTIAL-shaped stderr"
else
  fail "DETAILS missing the MISSING_CREDENTIAL stderr: $OUT"
fi
if printf '%s' "$OUT" | grep -q "DEEPSEEK_API_KEY"; then
  pass "DETAILS NAMES the missing credential DEEPSEEK_API_KEY"
else
  fail "DETAILS does not name the credential: $OUT"
fi
if grep -q "DEEPSEEK_API_KEY=UNSET" "$INVOC_LOG"; then
  pass "absent credential is NOT exported into the dsh invocation env"
else
  fail "absent credential marker missing: $(cat "$INVOC_LOG")"
fi

# ── Test 19d (US-004): --help documents the real dsh --spend answer leg ──
echo ""
echo "--- Test: US-004 --help documents the real dsh --spend answer leg ---"
if "$TOOL" --help | grep -q -- "--profile headless" && "$TOOL" --help | grep -q "MISSING_CREDENTIAL"; then
  pass "--help documents the real dsh --spend answer leg (--profile headless + MISSING_CREDENTIAL fail-closed)"
else
  fail "--help does not document the real dsh --spend answer leg"
fi
if "$TOOL" --help | grep -q "Reply with the single word OK and nothing else."; then
  pass "--help documents the sentinel one-shot prompt"
else
  fail "--help missing the sentinel prompt documentation"
fi
if "$TOOL" --help | grep -q -- "--dump-default-config"; then
  fail "--help still documents the removed --dump-default-config self-check"
else
  pass "--help no longer documents the --dump-default-config self-check"
fi

# ── Test 19 (US-002 AC1): OK line reports `credential source: env` ────
echo ""
echo "--- Test: US-002 pi credential source env ---"
provision_cred_home "$CRED_VAR"
: > "$INVOC_LOG"
OUT="$(DEEPSEEK_API_KEY=sk-test-env-deepseek-000 TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: env"; then
  pass "pi OK line reports 'credential source: env' when the key is in the invoking env"
else
  fail "pi OK line missing 'credential source: env' (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "hermes-dotenv"; then
  fail "pi OK line wrongly reports hermes-dotenv when env is set: $OUT"
else
  pass "pi source is NOT hermes-dotenv when env is set"
fi
if printf '%s' "$OUT" | grep -q "sk-test-env-deepseek-000\|sk-test-dotenv"; then
  fail "key VALUES leaked into probe output: $OUT"
else
  pass "probe output contains no key values"
fi

# ── Test 20 (US-002 AC1b): provider→env mapping beyond deepseek (openai) ──
echo ""
echo "--- Test: US-002 pi credential source env (openai default provider) ---"
provision_cred_home_openai "$CRED_VAR_OPENAI"
OUT="$(OPENAI_API_KEY=sk-test-env-openai-000 TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR_OPENAI" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: env"; then
  pass "pi (defaultProvider openai) OK line reports 'credential source: env'"
else
  fail "pi openai OK line missing 'credential source: env' (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "sk-test-env-openai-000\|sk-test-dotenv-openai-222"; then
  fail "key VALUES leaked into probe output: $OUT"
else
  pass "openai probe output contains no key values"
fi

# ── Test 21 (US-002 AC2): OK line reports `credential source: hermes-dotenv` ──
echo ""
echo "--- Test: US-002 pi credential source hermes-dotenv ---"
provision_cred_home "$CRED_VAR"
OUT="$(env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: hermes-dotenv"; then
  pass "pi OK line reports 'credential source: hermes-dotenv' when env unset + fixture .env present"
else
  fail "pi OK line missing 'credential source: hermes-dotenv' (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "credential source: env"; then
  fail "pi OK line reports env when the key is absent from env: $OUT"
else
  pass "pi source is NOT env when the key is unset"
fi
if printf '%s' "$OUT" | grep -q "sk-test-dotenv-deepseek-111"; then
  fail "dotenv key VALUE leaked into probe output: $OUT"
else
  pass "hermes-dotenv probe output contains no key values"
fi

# ── Test 22 (US-002 AC2b): dsh OK line (presence-only) reports the source ──
echo ""
echo "--- Test: US-002 dsh credential source hermes-dotenv (presence-only) ---"
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh" "$TOOL" dsh 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: hermes-dotenv" && printf '%s' "$OUT" | grep -q "alpha-skipped"; then
  pass "dsh OK line reports 'credential source: hermes-dotenv' + alpha-skipped"
else
  fail "dsh OK line missing source/alpha-skipped (rc=$RC): $OUT"
fi

# ── Test 23 (US-002 AC2c): hermes OK line reports the source ──────────
echo ""
echo "--- Test: US-002 hermes credential source hermes-dotenv ---"
provision_cred_home_hermes_deepseek "$CRED_VAR_HERMES"
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR_HERMES" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" hermes 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: hermes-dotenv"; then
  pass "hermes OK line reports 'credential source: hermes-dotenv' (deepseek default)"
else
  fail "hermes OK line missing 'credential source: hermes-dotenv' (rc=$RC): $OUT"
fi

# ── Test 23b (US-002 AC1c): hermes OK line reports env when the key is set ──
echo ""
echo "--- Test: US-002 hermes credential source env ---"
OUT="$(DEEPSEEK_API_KEY=sk-test-env-hermes-000 TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR_HERMES" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes" "$TOOL" hermes 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: env"; then
  pass "hermes OK line reports 'credential source: env' (deepseek default)"
else
  fail "hermes OK line missing 'credential source: env' (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "sk-test-env-hermes-000"; then
  fail "hermes env key VALUE leaked into probe output: $OUT"
else
  pass "hermes env probe output contains no key values"
fi

# ── Test 24 (US-002 AC3 / red-arm b): absent + failing answer → DETAILS names key ──
echo ""
echo "--- Test: US-002 pi fail-closed NAMES the missing key (env unset + .env absent) ---"
provision_cred_home "$CRED_VAR"
set +e
OUT="$(env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY TT_OPERATOR_HOME="$CRED_OP_NOENV" TT_VAR="$CRED_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi-fail" "$TOOL" pi 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe pi exits non-zero when credential absent + answer leg fails"
else
  fail "probe pi did NOT exit non-zero (absent credential + failing answer): $OUT"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: pi"; then
  pass "distinct reason 'harness-auth-missing: pi' preserved"
else
  fail "missing 'harness-auth-missing: pi': $OUT"
fi
if printf '%s' "$OUT" | grep -q "DEEPSEEK_API_KEY"; then
  pass "DETAILS NAMES the missing key DEEPSEEK_API_KEY"
else
  fail "DETAILS does not name the missing key: $OUT"
fi

# ── Test 25 (US-002 AC3b): dsh --spend absent → DETAILS names the key ──
echo ""
echo "--- Test: US-002 dsh --spend fail-closed NAMES the missing key ---"
set +e
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP_NOENV" TT_VAR="$CRED_VAR" TAMANDUA_DSH_BINARY="$FAKE_BIN/fake-dsh-fail" "$TOOL" --spend dsh 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe dsh --spend exits non-zero when credential absent + answer leg fails"
else
  fail "probe dsh --spend did NOT exit non-zero: $OUT"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: dsh"; then
  pass "distinct reason 'harness-auth-missing: dsh' preserved"
else
  fail "missing 'harness-auth-missing: dsh': $OUT"
fi
if printf '%s' "$OUT" | grep -q "DEEPSEEK_API_KEY"; then
  pass "dsh DETAILS NAMES the missing key DEEPSEEK_API_KEY"
else
  fail "dsh DETAILS does not name the missing key: $OUT"
fi

# ── Test 26 (US-002 AC3c): hermes absent → DETAILS names the key ──────
echo ""
echo "--- Test: US-002 hermes fail-closed NAMES the missing key ---"
provision_cred_home_hermes_deepseek "$CRED_VAR_HERMES"
set +e
OUT="$(env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP_NOENV" TT_VAR="$CRED_VAR_HERMES" TAMANDUA_HERMES_BINARY="$FAKE_BIN/fake-hermes-fail" "$TOOL" hermes 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "probe hermes exits non-zero when credential absent + answer leg fails"
else
  fail "probe hermes did NOT exit non-zero: $OUT"
fi
if printf '%s' "$OUT" | grep -q "harness-auth-missing: hermes"; then
  pass "distinct reason 'harness-auth-missing: hermes' preserved"
else
  fail "missing 'harness-auth-missing: hermes': $OUT"
fi
if printf '%s' "$OUT" | grep -q "DEEPSEEK_API_KEY"; then
  pass "hermes DETAILS NAMES the missing key DEEPSEEK_API_KEY"
else
  fail "hermes DETAILS does not name the missing key: $OUT"
fi

# ── Test 27 (US-002 AC1c): env wins over dotenv for the reported source ──
echo ""
echo "--- Test: US-002 env wins over hermes-dotenv ---"
provision_cred_home "$CRED_VAR"
OUT="$(DEEPSEEK_API_KEY=sk-test-env-deepseek-000 TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "credential source: env"; then
  pass "env wins: source=env even when the fixture .env also has the key"
else
  fail "env did NOT win over dotenv (rc=$RC): $OUT"
fi

# ── Test 28 (US-002 AC5): probe never writes to the operator fixture ──
echo ""
echo "--- Test: US-002 probe is read-only on the operator fixture ---"
SNAP_OP_BEFORE="$(find "$CRED_OP" -type f -exec sha256sum {} \; 2>/dev/null | sort | sha256sum)"
env -u DEEPSEEK_API_KEY TT_OPERATOR_HOME="$CRED_OP" TT_VAR="$CRED_VAR" TAMANDUA_PI_BINARY="$FAKE_BIN/fake-pi" "$TOOL" pi >/dev/null 2>&1
SNAP_OP_AFTER="$(find "$CRED_OP" -type f -exec sha256sum {} \; 2>/dev/null | sort | sha256sum)"
if [ "$SNAP_OP_BEFORE" = "$SNAP_OP_AFTER" ]; then
  pass "probe is read-only (operator fixture unchanged)"
else
  fail "probe mutated the operator fixture"
fi

# ── Test 29 (US-002 AC6): --help documents credential-source reporting ──
echo ""
echo "--- Test: US-002 --help documents credential-source reporting ---"
if "$TOOL" --help | grep -q "credential source"; then
  pass "--help documents the credential-source reporting"
else
  fail "--help does not document the credential-source reporting"
fi
if "$TOOL" --help | grep -q "hermes-dotenv" && "$TOOL" --help | grep -q "TT_OPERATOR_HOME"; then
  pass "--help documents the hermes-dotenv source + TT_OPERATOR_HOME seam"
else
  fail "--help does not document hermes-dotenv / TT_OPERATOR_HOME"
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
