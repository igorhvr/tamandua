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
# All harness invocations use FAKE pi/hermes binaries (seam TAMANDUA_PI_BINARY /
# TAMANDUA_HERMES_BINARY), so this self-test spends ZERO real tokens and starts
# no daemon. Confined to temp dirs under ${TMPDIR:-/tmp} — never operator state.
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
if [ "$(wc -l < "$INVOC_LOG")" = "1" ]; then
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
