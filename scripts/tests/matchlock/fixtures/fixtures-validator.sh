#!/usr/bin/env bash
# =============================================================================
# fixtures-validator.sh — behavioral controls for the tier-aware receipt
# validator (`validator/validate-receipts.sh`) and the requested manifest
# (`lib/manifest.sh`).
#
# One complete synthetic receipt set must validate OK, and every decisive
# negative/edge control must FAIL closed. Each control asserts the validator's
# exit code AND the decisive reason in its output; the manifest controls assert
# the recorded scope directly. The last line is always:
#
#   VALIDATOR FIXTURES RESULT: pass=<n> fail=<n>
#
# No VM, no model, no network. The scratch directory is a fresh `mktemp -d`
# (or `MTLK_VALIDATOR_FIXTURE_DIR` when set and owned by the caller) and is
# removed on exit when this script created it.
#
# Fixture layout exercised:
#   <ev>/identity.txt                          (via lib/common.sh writer)
#   <ev>/manifest/requested.tsv                (via lib/manifest.sh API)
#   <ev>/{T1,M0..M4}/case-summary.json
#   <ev>/matrix/run-cases.log                  (MATRIX-PHASE-DONE)
#   <ev>/WAVE-COMPLETED, <ev>/HALTED, <ev>/WAVE-FAILED
#   <ev>/M7/{m7-verdict-path.txt,m7.verdict,m7.log}
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
VALIDATOR="$SUITE_DIR/validator/validate-receipts.sh"
MANIFEST_LIB="$SUITE_DIR/lib/manifest.sh"

# The shared configuration/identity writer and the manifest API under test.
# shellcheck source=../lib/common.sh
. "$SUITE_DIR/lib/common.sh"
# shellcheck source=../lib/manifest.sh
. "$MANIFEST_LIB"

FIX_OWNED=0
if [ -n "${MTLK_VALIDATOR_FIXTURE_DIR:-}" ]; then
  FIX="$MTLK_VALIDATOR_FIXTURE_DIR"
  rm -rf "$FIX"
  mkdir -p "$FIX"
else
  FIX="$(mktemp -d -t mtlk-validator.XXXXXX 2>/dev/null || mktemp -d)"
  FIX_OWNED=1
fi

cleanup() {
  if [ "$FIX_OWNED" = "1" ] && [ -n "${FIX:-}" ]; then
    rm -rf "$FIX"
  fi
}
trap cleanup EXIT

EXP="sha256:3304d29190fcb84a1e302c10531916e2541483077c06d0beadb366da66bb2e64"
PASSN=0
FAILN=0

# ck <got> <want> <label>
ck() {
  if [ "$1" = "$2" ]; then
    PASSN=$((PASSN + 1))
    echo "ok   - $3"
  else
    FAILN=$((FAILN + 1))
    echo "FIXTURE-FAIL - $3 (got [$1] want [$2])"
  fi
}

# ck_contains <file> <pattern> <label>
ck_contains() {
  if grep -q -e "$2" "$1" 2>/dev/null; then
    PASSN=$((PASSN + 1))
    echo "ok   - $3"
  else
    FAILN=$((FAILN + 1))
    echo "FIXTURE-FAIL - $3 (log $1 lacks [$2])"
  fi
}

# ck_not_contains <file> <pattern> <label>
ck_not_contains() {
  if grep -q -e "$2" "$1" 2>/dev/null; then
    FAILN=$((FAILN + 1))
    echo "FIXTURE-FAIL - $3 (log $1 unexpectedly has [$2])"
  else
    PASSN=$((PASSN + 1))
    echo "ok   - $3"
  fi
}

# runv <evdir> <logfile> — run the validator, print its exit code.
runv() {
  ( bash "$VALIDATOR" "$1" "$EXP" >"$2" 2>&1 )
  echo $?
}

# write_summary <evdir> <case> <verdict> [unowned-json]
write_summary() {
  local d="$1" name="$2" verdict="$3" unowned="${4:-[]}"
  mkdir -p "$d/$name"
  printf '{"case":"%s","verdict":"%s","fail_reasons":[],"unowned_new_vms":%s}\n' \
    "$name" "$verdict" "$unowned" >"$d/$name/case-summary.json"
}

# write_m7 <evdir> — a bound PASS verdict file plus a PASS invocation log.
write_m7() {
  local d="$1"
  mkdir -p "$d/M7"
  printf 'PASS\n' >"$d/M7/m7.verdict"
  printf '%s\n' "$d/M7/m7.verdict" >"$d/M7/m7-verdict-path.txt"
  printf 'PASS log=%s verdict-file=PASS\n' "$d/M7/spot.log" >"$d/M7/m7.log"
}

# mk_scope <evdir> [t4] — record and FREEZE the requested manifest only.
mk_scope() {
  local d="$1" t4="${2:-0}" n
  MTLK_EXPECT_DIGEST="$EXP"
  MTLK_MODE="candidate"
  MTLK_TAMANDUA_SHA="deadbeefcafe"
  MTLK_MATCHLOCK_RPC_BIN="/usr/local/bin/matchlock"
  MTLK_GUEST_INIT="/usr/local/bin/guest-init"
  mtlk_write_identity "$d/identity.txt"
  mtlk_manifest_init "$d" >/dev/null
  mtlk_manifest_request_tier "$d" t1 >/dev/null
  mtlk_manifest_request_tier "$d" t2 >/dev/null
  mtlk_manifest_add_case "$d" t1 T1 1 T1 >/dev/null
  for n in M0 M1 M2 M3 M4; do
    mtlk_manifest_add_case "$d" t2 "$n" 1 "$n" >/dev/null
  done
  if [ "$t4" = "1" ]; then
    mtlk_manifest_request_tier "$d" t4 >/dev/null
  fi
  mtlk_manifest_freeze "$d" >/dev/null
}

# mk_evidence <evdir> [t4] — write the passing evidence tree.
mk_evidence() {
  local d="$1" t4="${2:-0}" n
  write_summary "$d" T1 PASS
  for n in M0 M1 M2 M3 M4; do
    write_summary "$d" "$n" PASS
  done
  mkdir -p "$d/matrix"
  printf 'MATRIX-CASE-RC M0 rc=0\nMATRIX-PHASE-DONE 2026-10-10T00:00:00Z\n' \
    >"$d/matrix/run-cases.log"
  : >"$d/WAVE-COMPLETED"
  if [ "$t4" = "1" ]; then
    write_m7 "$d"
  fi
}

# mk_pass <evdir> [t4] — a complete, fully passing receipt set.
mk_pass() {
  local d="$1" t4="${2:-0}" n
  rm -rf "$d"
  mkdir -p "$d"
  mk_scope "$d" "$t4"
  mtlk_manifest_mark "$d" t1 - PASS >/dev/null
  mtlk_manifest_mark "$d" t2 - PASS >/dev/null
  mtlk_manifest_mark "$d" t1 T1 PASS >/dev/null
  for n in M0 M1 M2 M3 M4; do
    mtlk_manifest_mark "$d" t2 "$n" PASS >/dev/null
  done
  if [ "$t4" = "1" ]; then
    mtlk_manifest_mark "$d" t4 - PASS >/dev/null
  fi
  mk_evidence "$d" "$t4"
}

echo '=== positive: T1+T2 requested, T3/T4 deliberately unrequested ==='
mk_pass "$FIX/pass" 0
ck "$(runv "$FIX/pass" "$FIX/pass.log")" 0 "positive rc=0"
ck "$(tail -n 1 "$FIX/pass.log")" "VALIDATION-OK $FIX/pass" "positive verdict line"
ck "$(mtlk_manifest_status "$FIX/pass" t3 -)" "UNEXECUTED" "unrequested t3 status UNEXECUTED"
ck "$(mtlk_manifest_status "$FIX/pass" t4 -)" "UNEXECUTED" "unrequested t4 status UNEXECUTED"
ck_not_contains "$FIX/pass.log" 'tier-not-pass:t3' "unrequested t3 is not a failure"
echo "positive validator result: $(tail -n 1 "$FIX/pass.log")"
# Emit the raw positive verdict line too, so callers can assert the exact
# VALIDATION-OK contract without reading the fixture's private log files.
tail -n 1 "$FIX/pass.log"

echo '=== positive: T4 requested with a bound M7 verdict file PASS ==='
mk_pass "$FIX/pass-t4" 1
ck "$(runv "$FIX/pass-t4" "$FIX/pass-t4.log")" 0 "positive-t4 rc=0"
ck "$(tail -n 1 "$FIX/pass-t4.log")" "VALIDATION-OK $FIX/pass-t4" "positive-t4 verdict line"
echo "positive-t4 validator result: $(tail -n 1 "$FIX/pass-t4.log")"
tail -n 1 "$FIX/pass-t4.log"

echo '=== positive: unrequested T4 is not consulted (stray M7 evidence ignored) ==='
mk_pass "$FIX/pass-stray" 0
write_m7 "$FIX/pass-stray"
ck "$(runv "$FIX/pass-stray" "$FIX/pass-stray.log")" 0 "unrequested-t4 rc=0"
ck "$(mtlk_manifest_status "$FIX/pass-stray" t4 -)" "UNEXECUTED" "stray M7 does not mark t4 passed"

echo '=== control: scope cannot shrink after freeze ==='
mk_pass "$FIX/shrink" 0
( mtlk_manifest_request_tier "$FIX/shrink" t3 >"$FIX/shrink.log" 2>&1 )
ck "$?" 2 "post-freeze request refused rc=2"
ck_contains "$FIX/shrink.log" 'scope-frozen' "post-freeze abort line"
( mtlk_manifest_init "$FIX/shrink" >"$FIX/shrink-reinit.log" 2>&1 )
ck "$?" 2 "re-init refused rc=2"
ck_contains "$FIX/shrink-reinit.log" 'manifest-exists' "re-init abort line"

echo '=== control: requested-but-not-executed required case FAILS ==='
mk_pass "$FIX/unexec" 0
sed -i.bak $'s/^case\tt2\tM3\t1\t1\tM3\tPASS$/case\tt2\tM3\t1\t1\tM3\tUNEXECUTED/' \
  "$FIX/unexec/manifest/requested.tsv"
rm -f "$FIX/unexec/M3/case-summary.json"
ck "$(mtlk_manifest_status "$FIX/unexec" t2 M3)" "UNEXECUTED" "M3 recorded UNEXECUTED"
ck "$(runv "$FIX/unexec" "$FIX/unexec.log")" 1 "unexecuted-required rc=1"
ck_contains "$FIX/unexec.log" 'case-not-pass:M3=UNEXECUTED' "unexecuted-required reason"

echo '=== control: finalize folds pending requested rows into FAIL/NOTRUN ==='
mk_pass "$FIX/final" 1
sed -i.bak $'s/^case\tt2\tM3\t1\t1\tM3\tPASS$/case\tt2\tM3\t1\t1\tM3\tUNEXECUTED/' \
  "$FIX/final/manifest/requested.tsv"
rm -f "$FIX/final/M3/case-summary.json"
mtlk_manifest_finalize "$FIX/final" >"$FIX/final.log" 2>&1
ck "$(mtlk_manifest_status "$FIX/final" t2 M3)" "FAIL" "finalize marks pending required case FAIL"
ck "$(mtlk_manifest_status "$FIX/final" t3 -)" "UNEXECUTED" "finalize leaves unrequested t3 UNEXECUTED"
ck_contains "$FIX/final.log" 'fail=1' "finalize summary counts the failure"

echo '=== negative: missing required case ==='
mk_pass "$FIX/n1" 0
rm -f "$FIX/n1/M3/case-summary.json"
ck "$(runv "$FIX/n1" "$FIX/n1.log")" 1 "missing-case rc=1"
ck_contains "$FIX/n1.log" '^VALIDATION-FAIL' "missing-case FAIL line"
ck_contains "$FIX/n1.log" 'missing-case-summary:M3' "missing-case reason"

echo '=== negative: failed case verdict ==='
mk_pass "$FIX/n2" 0
write_summary "$FIX/n2" M2 FAIL
ck "$(runv "$FIX/n2" "$FIX/n2.log")" 1 "failed-verdict rc=1"
ck_contains "$FIX/n2.log" 'case-verdict:M2=FAIL' "failed-verdict reason"

echo '=== negative: unowned VM in a passing summary ==='
mk_pass "$FIX/n3" 0
write_summary "$FIX/n3" M4 PASS '["vm-aaaaaaaa"]'
ck "$(runv "$FIX/n3" "$FIX/n3.log")" 1 "unowned-vm rc=1"
ck_contains "$FIX/n3.log" 'case-unowned:M4' "unowned-vm reason"

echo '=== negative: M7 fail line (bound verdict still PASS) ==='
mk_pass "$FIX/n4" 1
printf 'FAIL log=%s verdict-file=PASS\n' "$FIX/n4/M7/spot.log" >"$FIX/n4/M7/m7.log"
ck "$(runv "$FIX/n4" "$FIX/n4.log")" 1 "m7-fail-line rc=1"
ck_contains "$FIX/n4.log" 'm7-fail-line' "m7-fail-line reason"

echo '=== negative: contradictory markers (completed + failed) ==='
mk_pass "$FIX/n5" 0
: >"$FIX/n5/WAVE-FAILED"
ck "$(runv "$FIX/n5" "$FIX/n5.log")" 1 "contradictory rc=1"
ck_contains "$FIX/n5.log" 'contradictory-markers' "contradictory-markers reason"
ck_contains "$FIX/n5.log" 'wave-failed-present' "wave-failed-present reason"

echo '=== negative: identity mismatch ==='
mk_pass "$FIX/n6" 0
sed -i.bak 's/^expect_digest=.*/expect_digest=sha256:deadbeef/' "$FIX/n6/identity.txt"
ck "$(runv "$FIX/n6" "$FIX/n6.log")" 1 "identity rc=1"
ck_contains "$FIX/n6.log" 'identity-digest' "identity-digest reason"

echo '=== negative: M7 verdict file content is not PASS ==='
mk_pass "$FIX/n7" 1
printf 'FAIL\n' >"$FIX/n7/M7/m7.verdict"
ck "$(runv "$FIX/n7" "$FIX/n7.log")" 1 "m7-verdict-file rc=1"
ck_contains "$FIX/n7.log" 'm7-verdict-file' "m7-verdict-file reason"

echo '=== negative: M7 verdict path binding missing ==='
mk_pass "$FIX/n8" 1
rm -f "$FIX/n8/M7/m7-verdict-path.txt"
ck "$(runv "$FIX/n8" "$FIX/n8.log")" 1 "m7-binding rc=1"
ck_contains "$FIX/n8.log" 'm7-binding-missing' "m7-binding-missing reason"

echo '=== negative: HALTED present ==='
mk_pass "$FIX/n9" 0
: >"$FIX/n9/HALTED"
ck "$(runv "$FIX/n9" "$FIX/n9.log")" 1 "halted rc=1"
ck_contains "$FIX/n9.log" 'halted-present' "halted-present reason"

echo '=== negative: manifest missing (fail-closed) ==='
mk_pass "$FIX/n10" 0
rm -f "$FIX/n10/manifest/requested.tsv"
ck "$(runv "$FIX/n10" "$FIX/n10.log")" 1 "missing-manifest rc=1"
ck_contains "$FIX/n10.log" 'missing-manifest' "missing-manifest reason"

echo '=== negative: MATRIX-PHASE-DONE missing ==='
mk_pass "$FIX/n11" 0
: >"$FIX/n11/matrix/run-cases.log"
ck "$(runv "$FIX/n11" "$FIX/n11.log")" 1 "phase-done rc=1"
ck_contains "$FIX/n11.log" 'phase-done-missing' "phase-done-missing reason"

echo '=== negative: missing identity (fail-closed) ==='
mk_pass "$FIX/n12" 0
rm -f "$FIX/n12/identity.txt"
ck "$(runv "$FIX/n12" "$FIX/n12.log")" 1 "missing-identity rc=1"
ck_contains "$FIX/n12.log" 'missing-identity' "missing-identity reason"

echo ""
echo "VALIDATOR FIXTURES RESULT: pass=$PASSN fail=$FAILN"
[ "$FAILN" = 0 ]
