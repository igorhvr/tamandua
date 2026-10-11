#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — T1 no-VM runner.
#
#   t1-fixtures.sh [evidence-dir]
#
# T1 is the fast, no-VM, no-model tier. It runs, in order:
#
#   runner/pty-selftest.sh          the frozen PTY driver behavioral self-test
#   fixtures/fixtures-test.sh       run-case.sh + hygiene.sh negative controls
#   fixtures/fixtures-validator.sh  the tier-aware validator + manifest controls
#
# It boots NO VM, touches NO model, and takes NO gate lock, so it is safe to run
# anywhere (including a sandbox without /dev/kvm). A composed runner (the
# one-command entrypoint) writes the requested manifest; when this script runs
# standalone it records the requested T1 scope itself BEFORE executing.
#
# Component exit codes are captured DIRECTLY (never masked behind a pipeline)
# and each component's full output is tee'd to <evidence-dir>/T1/<name>.log.
# The runner prints every component's summary and always ends with:
#
#   T1 FIXTURES RESULT: pass=<n> fail=<n>
#
# exiting nonzero when ANY component failed to run or reported fail>0. It never
# turns a missing/failed control into a pass.
#
# Evidence dir:
#   * a composed caller passes its own fresh evidence dir, which is used IN
#     PLACE and never removed here; or
#   * a standalone run creates a fresh private `mktemp -d` and removes it on exit.
#
# Receipt: a standalone run records the requested T1 scope (lib/manifest.sh),
# writes the T1 case summary from the component results, and writes the
# phase-done marker only when every control passed. A composed run (a manifest
# already exists) never rewrites the recorded scope.
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$SELF_DIR"
# shellcheck source=lib/common.sh
. "$SUITE_DIR/lib/common.sh"
# shellcheck source=lib/manifest.sh
. "$SUITE_DIR/lib/manifest.sh"

# Component paths are configuration (a relocated checkout or a control can
# rebind them), defaulting to the in-repo T1 components.
SELFTEST="${MTLK_PTY_SELFTEST:-$SUITE_DIR/runner/pty-selftest.sh}"
FIX_TEST="${MTLK_T1_FIXTURES_TEST:-$SUITE_DIR/fixtures/fixtures-test.sh}"
FIX_VALIDATOR="${MTLK_T1_FIXTURES_VALIDATOR:-$SUITE_DIR/fixtures/fixtures-validator.sh}"

EV_ARG="${1:-}"
T1_OWNED=0
if [ -n "$EV_ARG" ]; then
  EV="$EV_ARG"
  mkdir -p "$EV" || {
    printf 'T1-ABORT cannot-create-evidence %s\n' "$EV" >&2
    exit 2
  }
else
  EV="$(mktemp -d -t mtlk-t1.XXXXXX 2>/dev/null || mktemp -d)" || {
    printf 'T1-ABORT mktemp-failed\n' >&2
    exit 2
  }
  T1_OWNED=1
fi
EV="$(cd -- "$EV" && pwd)"
T1DIR="$EV/T1"
mkdir -p "$T1DIR" "$EV/matrix" || {
  printf 'T1-ABORT cannot-create-evidence %s\n' "$EV" >&2
  exit 2
}
printf 'T1 evidence dir: %s\n' "$EV"

cleanup_t1() {
  if [ "$T1_OWNED" = "1" ] && [ -n "${EV:-}" ]; then
    rm -rf "$EV"
  fi
}
trap cleanup_t1 EXIT

# -----------------------------------------------------------------------------
# Record the requested T1 scope BEFORE anything executes, but only when no
# composed runner has recorded a scope already.
# -----------------------------------------------------------------------------
T1_RECEIPT=0
if [ ! -e "$(mtlk_manifest_file "$EV")" ]; then
  T1_RECEIPT=1
  mtlk_manifest_init "$EV" >/dev/null || exit 2
  mtlk_manifest_request_tier "$EV" t1 || exit 2
  mtlk_manifest_add_case "$EV" t1 T1 1 T1 || exit 2
  mtlk_manifest_freeze "$EV" >/dev/null || exit 2
fi
[ -f "$EV/identity.txt" ] || mtlk_write_identity "$EV/identity.txt"

T1_PASS=0
T1_FAIL=0
T1_BAD=0
T1_RC_BAD=0

# run_component <name> <script> [args...] — run one T1 component, tee its output
# to <evidence>/T1/<name>.log, and fold its summary counts into the totals. A
# missing script or a missing summary line is a hard failure (never a pass).
run_component() {
  local name="$1" script="$2" log rc counts p f
  shift 2
  log="$T1DIR/$name.log"
  if [ ! -f "$script" ]; then
    printf 'T1-COMPONENT-MISSING %s\n' "$script" >"$log"
    printf 'T1-COMPONENT %s rc=2 missing=%s\n' "$name" "$script"
    T1_FAIL=$((T1_FAIL + 1))
    T1_BAD=$((T1_BAD + 1))
    T1_RC_BAD=$((T1_RC_BAD + 1))
    return 0
  fi
  (bash "$script" "$@") >"$log" 2>&1
  rc=$?
  printf 'T1-COMPONENT %s rc=%s\n' "$name" "$rc"
  tail -n 2 "$log" 2>/dev/null || true
  counts="$(grep -oE 'pass=[0-9]+ fail=[0-9]+' "$log" | tail -n 1)"
  if [ -n "$counts" ]; then
    p="${counts#pass=}"
    p="${p%% *}"
    f="${counts##*fail=}"
    T1_PASS=$((T1_PASS + p))
    T1_FAIL=$((T1_FAIL + f))
  else
    printf 'T1-COMPONENT-NO-SUMMARY %s\n' "$name"
    T1_FAIL=$((T1_FAIL + 1))
    T1_BAD=$((T1_BAD + 1))
  fi
  if [ "$rc" != 0 ]; then
    T1_RC_BAD=$((T1_RC_BAD + 1))
  fi
  return 0
}

echo '--- T1 pty-selftest (frozen driver) ---'
run_component pty-selftest "$SELFTEST"
echo '--- T1 run-case/hygiene fixtures ---'
run_component fixtures-test "$FIX_TEST" "$SUITE_DIR"
echo '--- T1 validator fixtures ---'
run_component fixtures-validator "$FIX_VALIDATOR"

# -----------------------------------------------------------------------------
# Terminal verdict from the component results only.
# -----------------------------------------------------------------------------
T1_VERDICT=PASS
if [ "$T1_RC_BAD" != 0 ] || [ "$T1_FAIL" != 0 ] || [ "$T1_BAD" != 0 ]; then
  T1_VERDICT=FAIL
fi

if [ "$T1_VERDICT" = PASS ]; then
  REASONS='[]'
else
  REASONS='["t1-control-failed"]'
fi
printf '{"case":"T1","verdict":"%s","fail_reasons":%s,"unowned_new_vms":[]}\n' \
  "$T1_VERDICT" "$REASONS" >"$T1DIR/case-summary.json"

if [ "$T1_RECEIPT" = 1 ]; then
  if [ "$T1_VERDICT" = PASS ]; then
    mtlk_manifest_mark "$EV" t1 T1 PASS >/dev/null 2>&1 || true
    mtlk_manifest_mark "$EV" t1 - PASS >/dev/null 2>&1 || true
    printf 'MATRIX-PHASE-DONE %s\n' "$(date -u +%FT%TZ)" >>"$EV/matrix/run-cases.log"
  else
    mtlk_manifest_mark "$EV" t1 T1 FAIL >/dev/null 2>&1 || true
    mtlk_manifest_mark "$EV" t1 - FAIL >/dev/null 2>&1 || true
  fi
  mtlk_manifest_finalize "$EV" >>"$EV/matrix/t1-manifest.log" 2>&1 || true
fi

printf 'T1 FIXTURES RESULT: pass=%s fail=%s\n' "$T1_PASS" "$T1_FAIL"
if [ "$T1_VERDICT" = PASS ]; then
  exit 0
fi
exit 1
