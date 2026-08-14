#!/usr/bin/env bash
# tt-token-saver-stub.test.sh — unit tests for the managed pi-token-saver
# stub helper (S12 / E3.D US-009).
#
# Verifies the contained token-saver stub machinery in ISOLATION with fake pi
# binaries (zero tokens, no daemons, no launches):
#   AC1. install writes the managed stub into var/adapters-bin (executable,
#        managed marker), requires --evidence-log, re-install is idempotent,
#        and a foreign file at the target is refused with the distinct
#        reason foreign-stub-refusing-install (never overwritten)
#   AC2. the stub appends ONE JSON invocation record (ts/pid/argv0/argv/
#        resolved_pi) per invocation and runs the real pi with ALL arguments,
#        passing the exit code through — proven with a fake pi (exit 0 and
#        exit 7); records APPEND across invocations
#   AC3. real-pi resolution order: TAMANDUA_PI_BINARY wins over PATH; a set
#        but missing TAMANDUA_PI_BINARY fails closed (exit 127) and still
#        leaves an evidence record
#   AC4. remove deletes ONLY the managed stub (foreign file refused with
#        foreign-stub-refusing-remove and left intact; absent is a no-op)
#
# Standalone: bash torture-test/bin/tt-token-saver-stub.test.sh
# Not part of `npm test`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
HELPER="$SCRIPT_DIR/tt-token-saver-stub"
STUB_PATH="$TT_DIR/var/adapters-bin/pi-token-saver"

PASS=0
FAIL=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tt-token-saver-stub.test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node is required for the stub and this test" >&2
  exit 0
fi

EVIDENCE_LOG="$TMP/evidence.jsonl"
EVIDENCE_LOG2="$TMP/evidence-2.jsonl"

# Fake pi: records its argv one-arg-per-line, exits with FAKE_PI_EXIT_CODE.
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
FAKE_PI_ARGV_LOG="$TMP/fake-pi-argv.txt"
FAKE_PI="$FAKEBIN/pi"
cat > "$FAKE_PI" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${FAKE_PI_ARGV_LOG:?}"
exit "${FAKE_PI_EXIT_CODE:-0}"
EOF
chmod +x "$FAKE_PI"

# Second fake for the TAMANDUA_PI_BINARY precedence check.
FAKE_PI2_ARGV_LOG="$TMP/fake-pi2-argv.txt"
FAKE_PI2="$TMP/pi-env-override"
cat > "$FAKE_PI2" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${FAKE_PI2_ARGV_LOG:?}"
exit 3
EOF
chmod +x "$FAKE_PI2"

# ── deterministic baseline: no stub ───────────────────────────────────
set +e
"$HELPER" remove >/dev/null 2>&1
set -e

# ── AC1: install contract ────────────────────────────────────────────
set +e
NO_LOG_OUT="$("$HELPER" install 2>&1)"; NO_LOG_RC=$?
set -e
if [ "$NO_LOG_RC" -eq 2 ]; then ok "AC1 install without --evidence-log exits 2"; else fail "AC1 install without --evidence-log rc=$NO_LOG_RC"; fi

INSTALL_OUT="$("$HELPER" install --evidence-log "$EVIDENCE_LOG" 2>&1)"; INSTALL_RC=$?
if [ "$INSTALL_RC" -eq 0 ]; then ok "AC1 install exits 0"; else fail "AC1 install rc=$INSTALL_RC"; echo "$INSTALL_OUT" | tail -5; fi
if echo "$INSTALL_OUT" | grep -q "TT_TOKEN_SAVER_STUB: installed" \
   && echo "$INSTALL_OUT" | grep -q "TT_TOKEN_SAVER_EVIDENCE_LOG: $EVIDENCE_LOG"; then
  ok "AC1 install reports installed + evidence log path"
else
  fail "AC1 install output contract"
  echo "$INSTALL_OUT" | tail -5
fi
if [ -x "$STUB_PATH" ]; then ok "AC1 stub is executable: $STUB_PATH"; else fail "AC1 stub missing/not executable"; fi
if grep -aqF "tt-managed pi-token-saver stub" "$STUB_PATH"; then ok "AC1 stub carries the managed marker"; else fail "AC1 stub lacks managed marker"; fi
if grep -aqF "\"$EVIDENCE_LOG\"" "$STUB_PATH"; then ok "AC1 stub embeds the evidence log path"; else fail "AC1 stub does not embed evidence log path"; fi

# re-install with a DIFFERENT log: idempotent update, exit 0
REINSTALL_OUT="$("$HELPER" install --evidence-log "$EVIDENCE_LOG2" 2>&1)"; REINSTALL_RC=$?
if [ "$REINSTALL_RC" -eq 0 ]; then ok "AC1 re-install (new evidence log) exits 0"; else fail "AC1 re-install rc=$REINSTALL_RC"; fi
if grep -aqF "\"$EVIDENCE_LOG2\"" "$STUB_PATH" && ! grep -aqF "\"$EVIDENCE_LOG\"" "$STUB_PATH"; then
  ok "AC1 re-install updated the embedded evidence log"
else
  fail "AC1 re-install did not update the embedded evidence log"
fi

# foreign file at the target: install refuses, never overwrites
mv "$STUB_PATH" "$TMP/managed-backup"
printf '#!/bin/sh\necho foreign\n' > "$STUB_PATH"
chmod +x "$STUB_PATH"
set +e
FOREIGN_INSTALL_OUT="$("$HELPER" install --evidence-log "$EVIDENCE_LOG" 2>&1)"; FOREIGN_INSTALL_RC=$?
set -e
if [ "$FOREIGN_INSTALL_RC" -ne 0 ]; then ok "AC1 install over foreign file exits non-zero"; else fail "AC1 install over foreign file should fail"; fi
if echo "$FOREIGN_INSTALL_OUT" | grep -q "REASON: foreign-stub-refusing-install"; then
  ok "AC1 install over foreign file emits foreign-stub-refusing-install"
else
  fail "AC1 missing foreign-stub-refusing-install reason"
fi
if grep -q "echo foreign" "$STUB_PATH"; then ok "AC1 foreign file left intact by install"; else fail "AC1 foreign file was modified"; fi

# ── AC4 (pre): remove refuses the foreign file and leaves it intact ──
set +e
FOREIGN_REMOVE_OUT="$("$HELPER" remove 2>&1)"; FOREIGN_REMOVE_RC=$?
set -e
if [ "$FOREIGN_REMOVE_RC" -ne 0 ]; then ok "AC4 remove of foreign file exits non-zero"; else fail "AC4 remove of foreign file should fail"; fi
if echo "$FOREIGN_REMOVE_OUT" | grep -q "REASON: foreign-stub-refusing-remove"; then
  ok "AC4 remove of foreign file emits foreign-stub-refusing-remove"
else
  fail "AC4 missing foreign-stub-refusing-remove reason"
fi
if [ -f "$STUB_PATH" ] && grep -q "echo foreign" "$STUB_PATH"; then ok "AC4 foreign file survives remove"; else fail "AC4 foreign file was deleted"; fi

# restore the managed stub for the invocation tests: a fresh install with
# the primary evidence log (also re-proves idempotent re-install)
rm -f -- "$STUB_PATH"
RESTORE_OUT="$("$HELPER" install --evidence-log "$EVIDENCE_LOG" 2>&1)"; RESTORE_RC=$?
if [ "$RESTORE_RC" -eq 0 ] && grep -aqF "\"$EVIDENCE_LOG\"" "$STUB_PATH"; then
  ok "AC1 restore install re-embeds the primary evidence log"
else
  fail "AC1 restore install rc=$RESTORE_RC"
fi

# ── AC2: invocation records + argv + exit-code pass-through ──────────
invoke_stub() { # args: exit_code, then stub args...
  local want_rc="$1"; shift
  env -u TAMANDUA_PI_BINARY PATH="$FAKEBIN:$PATH" \
      FAKE_PI_ARGV_LOG="$FAKE_PI_ARGV_LOG" FAKE_PI_EXIT_CODE="$want_rc" \
      "$STUB_PATH" "$@"
}

rm -f "$EVIDENCE_LOG" "$FAKE_PI_ARGV_LOG"
set +e
RC7_OUT="$(invoke_stub 7 --print --mode json 'hello world' 'arg with spaces' '' 2>&1)"; RC7=$?
set -e
if [ "$RC7" -eq 7 ]; then ok "AC2 exit-code pass-through: stub exited 7 like the fake pi"; else fail "AC2 stub exited $RC7, expected 7 (out: ${RC7_OUT:0:200})"; fi
EXPECTED_ARGV_JSON='["--print","--mode","json","hello world","arg with spaces",""]'
ARGV_MATCH="$(node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  const argv = text.split("\n").slice(0, -1); // drop the trailing newline artifact
  process.stdout.write(JSON.stringify(JSON.stringify(argv) === process.argv[2]));
' "$FAKE_PI_ARGV_LOG" "$EXPECTED_ARGV_JSON")"
if [ "$ARGV_MATCH" = "true" ]; then
  ok "AC2 argv pass-through: fake pi received every argument verbatim (incl. empty string)"
else
  fail "AC2 argv mismatch: got $(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$FAKE_PI_ARGV_LOG")"
fi

# exit 0 pass-through + record APPEND (second line)
set +e
invoke_stub 0 -m quick >/dev/null 2>&1; RC0=$?
set -e
if [ "$RC0" -eq 0 ]; then ok "AC2 exit-code pass-through: stub exited 0 like the fake pi"; else fail "AC2 stub exited $RC0, expected 0"; fi

LINE_COUNT="$(wc -l < "$EVIDENCE_LOG" 2>/dev/null || echo 0)"
if [ "$LINE_COUNT" -eq 2 ]; then ok "AC2 evidence log has exactly 2 appended records (append, not overwrite)"; else fail "AC2 evidence log line count $LINE_COUNT, expected 2"; fi

# structural JSON checks on the FIRST record
REC1="$(sed -n '1p' "$EVIDENCE_LOG")"
check_record() {
  local label="$1" rec="$2" expect_argv_json="$3" expect_resolved="$4"
  local parsed
  parsed="$(node -e '
    const rec = JSON.parse(process.argv[1]);
    const checks = {
      ts: typeof rec.ts === "string" && !Number.isNaN(Date.parse(rec.ts)),
      pid: Number.isInteger(rec.pid) && rec.pid > 0,
      argv0: typeof rec.argv0 === "string" && rec.argv0.endsWith("/pi-token-saver"),
      argv_json: JSON.stringify(rec.argv) === process.argv[2],
      resolved_pi: rec.resolved_pi === process.argv[3],
    };
    process.stdout.write(JSON.stringify(checks));
  ' "$rec" "$expect_argv_json" "$expect_resolved")"
  if [ "$parsed" = '{"ts":true,"pid":true,"argv0":true,"argv_json":true,"resolved_pi":true}' ]; then
    ok "$label"
  else
    fail "$label — record: $(echo "$rec" | head -c 300); checks: $parsed"
  fi
}
check_record "AC2 record 1: ts ISO / pid>0 / argv0 stub / argv exact / resolved_pi from PATH" \
  "$REC1" '["--print","--mode","json","hello world","arg with spaces",""]' "$FAKE_PI"

REC2="$(sed -n '2p' "$EVIDENCE_LOG")"
check_record "AC2 record 2: second invocation appended with its own argv" \
  "$REC2" '["-m","quick"]' "$FAKE_PI"

# ── AC3: real-pi resolution order ────────────────────────────────────
# TAMANDUA_PI_BINARY wins over PATH: the second fake runs (exit 3), the PATH
# fake must NOT run, and resolved_pi names the override.
BEFORE_PI1="$(cat "$FAKE_PI_ARGV_LOG" 2>/dev/null || true)"
rm -f "$FAKE_PI2_ARGV_LOG"
set +e
TAMANDUA_PI_BINARY="$FAKE_PI2" PATH="$FAKEBIN:$PATH" FAKE_PI2_ARGV_LOG="$FAKE_PI2_ARGV_LOG" \
  "$STUB_PATH" --override-run >/dev/null 2>&1; RC_ENV=$?
set -e
if [ "$RC_ENV" -eq 3 ]; then ok "AC3 TAMANDUA_PI_BINARY override runs (exit 3 pass-through)"; else fail "AC3 override run rc=$RC_ENV, expected 3"; fi
if [ "$(cat "$FAKE_PI2_ARGV_LOG")" = "--override-run" ]; then ok "AC3 override fake received the args"; else fail "AC3 override fake argv mismatch"; fi
if [ "$(cat "$FAKE_PI_ARGV_LOG")" = "$BEFORE_PI1" ]; then ok "AC3 PATH fake NOT invoked when TAMANDUA_PI_BINARY is set"; else fail "AC3 PATH fake was invoked despite TAMANDUA_PI_BINARY"; fi
REC3="$(tail -n 1 "$EVIDENCE_LOG")"
parsed3="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({argv:JSON.stringify(r.argv),resolved:r.resolved_pi===process.argv[2]}))' "$REC3" "$FAKE_PI2")"
if [ "$parsed3" = '{"argv":"[\"--override-run\"]","resolved":true}' ]; then ok "AC3 record names the override as resolved_pi"; else fail "AC3 record mismatch: $parsed3"; fi

# set-but-missing TAMANDUA_PI_BINARY: fail closed (127) + evidence record
BEFORE_COUNT="$(wc -l < "$EVIDENCE_LOG")"
set +e
MISSING_OUT="$(TAMANDUA_PI_BINARY="$TMP/no-such-pi" PATH="$FAKEBIN:$PATH" "$STUB_PATH" --boom 2>&1)"; MISSING_RC=$?
set -e
if [ "$MISSING_RC" -eq 127 ]; then ok "AC3 missing TAMANDUA_PI_BINARY fails closed with 127"; else fail "AC3 missing binary rc=$MISSING_RC, expected 127"; fi
if echo "$MISSING_OUT" | grep -q "failed to run real pi"; then ok "AC3 missing binary reports the failure on stderr"; else fail "AC3 missing binary stderr lacks the failure message"; fi
AFTER_COUNT="$(wc -l < "$EVIDENCE_LOG")"
if [ "$AFTER_COUNT" -eq $((BEFORE_COUNT + 1)) ]; then ok "AC3 missing-binary invocation still leaves an evidence record"; else fail "AC3 missing-binary record not appended ($BEFORE_COUNT -> $AFTER_COUNT)"; fi

# ── AC4: remove precision ────────────────────────────────────────────
REMOVE_OUT="$("$HELPER" remove 2>&1)"; REMOVE_RC=$?
if [ "$REMOVE_RC" -eq 0 ]; then ok "AC4 remove of managed stub exits 0"; else fail "AC4 remove rc=$REMOVE_RC"; fi
if echo "$REMOVE_OUT" | grep -q "TT_TOKEN_SAVER_STUB: removed"; then ok "AC4 remove reports removed"; else fail "AC4 remove output contract"; fi
if [ ! -e "$STUB_PATH" ] && [ ! -L "$STUB_PATH" ]; then ok "AC4 managed stub deleted"; else fail "AC4 managed stub still present"; fi

REMOVE2_OUT="$("$HELPER" remove 2>&1)"; REMOVE2_RC=$?
if [ "$REMOVE2_RC" -eq 0 ] && echo "$REMOVE2_OUT" | grep -q "TT_TOKEN_SAVER_STUB: absent"; then
  ok "AC4 second remove (absent) is a no-op success"
else
  fail "AC4 second remove rc=$REMOVE2_RC"
fi

# final sweep: adapters-bin back to empty (hygiene)
if [ -d "$TT_DIR/var/adapters-bin" ] && [ -z "$(ls -A "$TT_DIR/var/adapters-bin" 2>/dev/null)" ]; then
  ok "sweep: var/adapters-bin empty after tests"
else
  fail "sweep: var/adapters-bin not empty: $(ls -A "$TT_DIR/var/adapters-bin" 2>/dev/null | tr '\n' ' ')"
fi

echo ""
echo "---------------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed"
echo "---------------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
