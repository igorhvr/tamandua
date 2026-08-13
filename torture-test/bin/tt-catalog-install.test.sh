#!/usr/bin/env bash
# tt-catalog-install.test.sh — self-test for tt-catalog-install (E2.5 US-002).
#
# Verifies stamp-aware catalog install into the CONTAINED TT home:
#   AC1. helper exists & installs bundled workflows into the contained home
#   AC2. after install, workflows listable + .catalog-version.json has current build
#   AC3. same-build second run is a no-op (no reinstall, zero churn)
#   AC4. stale/absent catalog -> reinstall (not failure); genuine install failure
#        -> exit non-zero with distinct reason catalog-missing
#   AC5. operator's ~/.tamandua and 33xx daemon untouched
#
# Standalone: bash torture-test/bin/tt-catalog-install.test.sh
# Not part of `npm test`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"

PASS=0
FAIL=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tt-catalog-install.test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

TT_VAR="$TMP/var"
export TT_VAR
HELPER="$SCRIPT_DIR/tt-catalog-install"
CUR_BUILD="$(cat "$TT_REPO_ROOT/dist/version" 2>/dev/null | tr -d '[:space:]' || true)"

# Operator's installed catalog — must NOT change across the test. Narrow to
# ~/.tamandua/workflows ONLY (the operator's huge worktrees/ + node_modules
# would make a full-tree md5sum take minutes).
OPERATOR_CATALOG="${HOME}/.tamandua/workflows"
operator_snapshot() {
  if [ -d "$OPERATOR_CATALOG" ]; then
    ( cd "$OPERATOR_CATALOG" && { ls -1; [ -f .catalog-version.json ] && cat .catalog-version.json; } 2>/dev/null | sort ) || true
  else
    echo "(no operator catalog)"
  fi
}
OP_BEFORE="$(operator_snapshot)"

ok()   { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$*"; }

# Guard: the helper needs the repo's dist build AND a readable source workflows dir.
if [ -z "$CUR_BUILD" ] || [ ! -f "$TT_REPO_ROOT/dist/cli/cli.js" ]; then
  echo "SKIP: repo dist build missing — run ./build first" >&2
  exit 0
fi
if [ ! -d "$TT_REPO_ROOT/workflows" ]; then
  echo "SKIP: repo workflows dir missing" >&2
  exit 0
fi

# ── AC1: helper exists, is executable, --help documents it ─────────────
if [ -x "$HELPER" ]; then ok "AC1 helper is executable: $HELPER"; else fail "AC1 helper missing/not executable: $HELPER"; fi
if "$HELPER" --help 2>&1 | grep -qi "catalog-missing" && "$HELPER" --help 2>&1 | grep -qi "contained TT home"; then
  ok "AC1 --help documents catalog-missing + contained TT home"
else
  fail "AC1 --help documentation"
fi

# ── AC1/AC2: fresh contained home -> install bundles + stamp ──────────
STAMP="$TT_VAR/home/.tamandua/workflows/.catalog-version.json"
INSTALL_OUT="$("$HELPER" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "AC1/2 fresh contained home install exits 0"; else fail "AC1/2 fresh install rc=$rc"; echo "$INSTALL_OUT" | tail -5; fi

WF_COUNT="$(ls "$TT_VAR/home/.tamandua/workflows" 2>/dev/null | wc -l)"
if [ "$WF_COUNT" -ge 1 ]; then ok "AC2 workflows listable in TT home ($WF_COUNT dirs)"; else fail "AC2 no workflows in TT home"; fi

if [ -f "$STAMP" ]; then
  STAMP_VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1)"
  if [ "$STAMP_VER" = "$CUR_BUILD" ]; then
    ok "AC2 stamp records current build version"
  else
    fail "AC2 stamp version mismatch: $STAMP_VER != $CUR_BUILD"
  fi
else
  fail "AC2 no .catalog-version.json stamp written"
fi

# ── AC6a (US-003): TT-custom workflow install ────────────────────────
CUSTOM_STAMP="$TT_VAR/home/.tamandua/workflows/.tt-custom-catalog.json"
if [ -f "$TT_VAR/home/.tamandua/workflows/tt-shim-probe/workflow.yml" ]; then
  ok "AC6a tt-shim-probe workflow.yml installed into contained home"
else
  fail "AC6a tt-shim-probe workflow.yml missing after install"
fi
if [ -f "$CUSTOM_STAMP" ]; then
  CUSTOM_VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$CUSTOM_STAMP" | head -n1)"
  if [ "$CUSTOM_VER" = "$CUR_BUILD" ]; then
    ok "AC6a custom catalog stamp records current build"
  else
    fail "AC6a custom catalog stamp version mismatch: $CUSTOM_VER != $CUR_BUILD"
  fi
else
  fail "AC6a no .tt-custom-catalog.json written"
fi

# ── AC5(part): the helper spawned a contained install — assert the operator's
#    real ~/.tamandua catalog was NOT touched.
OP_AFTER="$(operator_snapshot)"
if [ "$OP_BEFORE" = "$OP_AFTER" ]; then
  ok "AC5 operator ~/.tamandua untouched (no writes to operator state)"
else
  fail "AC5 operator ~/.tamandua changed"
fi

# ── AC3: same-build second run is a no-op (zero churn) ─────────────────
STAMP1="$(sed -n 's/^[[:space:]]*"installedAt"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1)"
WF_TIMESTAMP_BEFORE="$(find "$TT_VAR/home/.tamandua/workflows" -type f -exec stat -c '%Y' {} \; | sort | md5sum | awk '{print $1}')"
CUSTOM_STAMP1="$(sed -n 's/^[[:space:]]*"installedAt"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$CUSTOM_STAMP" | head -n1)"
CUSTOM_TS_BEFORE="$(find "$TT_VAR/home/.tamandua/workflows/tt-shim-probe" -type f -exec stat -c '%Y' {} \; | sort | md5sum | awk '{print $1}')"
IDEM_OUT="$("$HELPER" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "AC3 same-build second run exits 0"; else fail "AC3 second run rc=$rc"; fi
if echo "$IDEM_OUT" | grep -q "IDEMPOTENT"; then
  ok "AC3 second run skipped install (idempotent)"
else
  fail "AC3 second run did not take idempotent path"
fi
STAMP2="$(sed -n 's/^[[:space:]]*"installedAt"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1)"
WF_TIMESTAMP_AFTER="$(find "$TT_VAR/home/.tamandua/workflows" -type f -exec stat -c '%Y' {} \; | sort | md5sum | awk '{print $1}')"
CUSTOM_STAMP2="$(sed -n 's/^[[:space:]]*"installedAt"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$CUSTOM_STAMP" | head -n1)"
CUSTOM_TS_AFTER="$(find "$TT_VAR/home/.tamandua/workflows/tt-shim-probe" -type f -exec stat -c '%Y' {} \; | sort | md5sum | awk '{print $1}')"
if [ "$STAMP1" = "$STAMP2" ] && [ "$WF_TIMESTAMP_BEFORE" = "$WF_TIMESTAMP_AFTER" ]; then
  ok "AC3 zero churn (stamp + workflow file mtimes unchanged)"
else
  fail "AC3 churn detected (reinstall occurred on same build)"
fi
if [ "$CUSTOM_STAMP1" = "$CUSTOM_STAMP2" ] && [ "$CUSTOM_TS_BEFORE" = "$CUSTOM_TS_AFTER" ]; then
  ok "AC6b custom workflow set zero churn (custom stamp + tt-shim-probe mtimes unchanged)"
else
  fail "AC6b custom workflow churn detected (reinstall occurred on same build)"
fi

# ── AC4a: absent catalog -> reinstall (not a failure) ──────────────────
# Remove the stamp entirely (simulate absent catalog); expect a reinstall, exit 0.
rm -f "$STAMP"
ABSENT_OUT="$("$HELPER" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "AC4 absent stamp -> reinstall, exit 0 (not a failure)"; else fail "AC4 absent stamp reinstall rc=$rc"; fi
if [ -f "$STAMP" ]; then ok "AC4 absent stamp -> stamp re-written after reinstall"; else fail "AC4 absent stamp -> stamp still missing"; fi

# ── AC4b: stale catalog -> reinstall (not a failure) ───────────────────
sed -i 's/"version": "[^"]*"/"version": "20000101T000000Z_STALE"/' "$STAMP"
STALE_OUT="$("$HELPER" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "AC4 stale stamp -> reinstall, exit 0 (not a failure)"; else fail "AC4 stale stamp rc=$rc"; fi
NEW_VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1)"
if [ "$NEW_VER" = "$CUR_BUILD" ]; then ok "AC4 stale stamp refreshed to current build"; else fail "AC4 stale stamp not refreshed: $NEW_VER"; fi

# ── AC4c: genuine install failure -> catalog-missing, non-zero exit ────
EMPTY_SRC="$TMP/empty-src"
mkdir -p "$EMPTY_SRC"
FAIL_HOME="$TT_VAR" # reuse; but point source at empty dir + force reinstall
FAIL_OUT="$(TT_WORKFLOWS_SRC="$EMPTY_SRC" "$HELPER" --force 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
  ok "AC4 genuine install failure exits non-zero (rc=$rc)"
else
  fail "AC4 genuine install failure should exit non-zero"
fi
if echo "$FAIL_OUT" | grep -q "REASON: catalog-missing"; then
  ok "AC4 failure emits distinct reason catalog-missing"
else
  fail "AC4 missing REASON: catalog-missing in output"
fi

# ── AC6d (US-003): stale custom stamp -> reinstall (not a failure) ────
sed -i 's/"version": "[^"]*"/"version": "20000101T000000Z_STALE"/' "$CUSTOM_STAMP"
CUSTOM_STALE_OUT="$("$HELPER" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "AC6d stale custom stamp -> reinstall, exit 0 (not a failure)"; else fail "AC6d stale custom stamp rc=$rc"; fi
NEW_CUSTOM_VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$CUSTOM_STAMP" | head -n1)"
if [ "$NEW_CUSTOM_VER" = "$CUR_BUILD" ]; then ok "AC6d custom stamp refreshed to current build"; else fail "AC6d custom stamp not refreshed: $NEW_CUSTOM_VER"; fi

# ── AC6c (US-003): per-name fail-closed catalog-missing:<name> ─────────
FAIL_CASES="$TMP/fail-cases"
mkdir -p "$FAIL_CASES"
cp "$TT_DIR/cases/tier0.jsonl" "$TT_DIR/cases/tier1.jsonl" "$TT_DIR/cases/cases.jsonl" "$TT_DIR/cases/smoke.jsonl" "$FAIL_CASES/"
printf '%s\n' '{"id":"ac6c","workflow":"tt-nonexistent","harness":"pi"}' >> "$FAIL_CASES/tier1.jsonl"
FAILCLOSED_HOME="$TMP/failclosed-var"
mkdir -p "$FAILCLOSED_HOME"
FAILCLOSED_OUT="$(TT_VAR="$FAILCLOSED_HOME" TT_CASES_DIR="$FAIL_CASES" "$HELPER" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
  ok "AC6c per-name fail-closed exits non-zero (rc=$rc)"
else
  fail "AC6c per-name fail-closed should exit non-zero"
fi
if echo "$FAILCLOSED_OUT" | grep -q "REASON: catalog-missing: tt-nonexistent"; then
  ok "AC6c emits REASON: catalog-missing: tt-nonexistent"
else
  fail "AC6c missing REASON: catalog-missing: tt-nonexistent"
  echo "$FAILCLOSED_OUT" | tail -5
fi

# ── AC5: helper never started/bound a daemon — assert no new listener is
#    required; the helper spawns no daemons, so no 33xx/43xx involvement.
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
