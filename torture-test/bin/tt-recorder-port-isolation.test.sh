#!/usr/bin/env bash
# tt-recorder-port-isolation.test.sh — RISO US-002 focused port-isolation
# regression for the tt-recorder recorder self-test repair.
#
# This is the US-002 gate (honest port-exclusion coverage without production
# listeners). It sources the SAME guards library the full harness sources
# (bin/tt-recorder-selftest-guards.sh), so the port-observation scenario
# code and the reintroduction guard it exercises are byte-identical to what
# the full harness's US-009 section (Test 88 / Test 92) ships, and it NEVER
# runs the full legacy harness. It never binds or probes production ports
# 3334/3338/3339 — no socket is ever created on them and nothing connects to
# a production listener — and every mutable fixture and process belongs to
# this invocation.
#
# What this regression proves (each via PASS/FAIL, exit 0 only with zero
# FAIL lines):
#   * ALLOWED contained-process observation (negative control): a contained
#     process whose cwd is under the fixture var and that listens on an
#     OS-selected random high port (python3 bind to 127.0.0.1:0) IS present
#     in the REAL discover_processes output and the REAL _is_production_ports
#     answers 1 (not production) — an always-exclude implementation fails;
#   * EXCLUDED production-port observation (positive control): a synthetic
#     NON-EXISTENT pid (no live process, no real listener) plus a fixture-
#     owned PATH shim whose fake lsof reports that pid listening on
#     production port 3334 (shim invocation logged) makes the REAL
#     _is_production_ports return 0 (production) and the verbose
#     'excluding production process' line fires under TT_RECORDER_VERBOSE —
#     an always-include implementation fails; with NO lsof on PATH the same
#     pid degrades to rc 1 + the tool's explicit degradation line (the
#     decision is evidence-driven, never vacuous);
#   * Honesty rule: when the contained listener fails to start or the lsof
#     shim/coverage cannot be established the checks FAIL (increment
#     FAILURES) — never a vacuous PASS;
#   * Reintroduction guard: the guard PASSes on the real harness source and
#     the fixture tool copy, and TRIPS (non-zero exit + clear VIOLATION
#     lines) on scratch copies of the harness that reintroduce (a) an
#     executed bind to a literal production port or (b) source-checkout
#     state usage ($_SRC_BIN-derived var removal);
#   * Hygiene: only the fixture root is cleanup-registered and no owned
#     children survive (exit cleanup stops everything it owns and removes
#     only the recorded root).
#
# Like the other recorder self-test files this is NOT part of the normal
# torture-test/self-tests/run.sh battery; it is invoked directly as the
# port-isolation gate (bash torture-test/bin/tt-recorder-port-isolation.test.sh).
# GNU/Linux-only (bash 3.2-compatible syntax, same as the harness family).
# Kept free of the literal procfs mount so it needs no portability-lint
# allowlist entry of its own.
set -euo pipefail

_SRC_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$_SRC_BIN/tt-recorder-selftest-guards.sh"

riso_bootstrap_fixture tt-recorder-port-isolation

echo ""
echo "=== RISO US-002: port-isolation regression (no production listeners) ==="
echo "  fixture root: $FIXTURE_ROOT"

# ── Both port observations (shared scenario code, byte-identical to the
#    full harness's Test 88 section) ─────────────────────────────────────
echo ""
echo "--- RISO: allowed contained listener (negative control) + excluded production port (positive control) ---"

FPO_FAKE_HOME="$TT_ROOT_VAR/fake-home-$$"
mkdir -p "$FPO_FAKE_HOME"

riso_port_allowed_contained "$FPO_FAKE_HOME" "iso-a"
riso_port_excluded_production "iso-b"

# ── Reintroduction guard: PASS on the real targets, TRIP on scratch copies ─
echo ""
echo "--- RISO: reintroduction guard (pass on repaired files; trips on reintroduced binds / checkout state) ---"

riso_reintroduction_guard "$_SRC_BIN/tt-recorder.test.sh" "harness source"
riso_reintroduction_guard "$TOOL" "fixture tool copy"

# Trip proofs run the guard in a CHILD (its FAIL only affects the child; the
# parent asserts the non-zero exit + clear violation message).
FPO_SCRATCH_DIR="$FIXTURE_ROOT/reintroduction-scratch"
mkdir -p "$FPO_SCRATCH_DIR"
cp "$_SRC_BIN/tt-recorder.test.sh" "$FPO_SCRATCH_DIR/harness-scratch.sh"
cp "$_SRC_BIN/tt-recorder-selftest-guards.sh" "$FPO_SCRATCH_DIR/guards-scratch.sh"

# (a) a scratch copy with an executed production-port bind reintroduced (the
#     old Test-88 bind form — scratch file, never executed; the static guard
#     must flag it):
printf '%s\n' "s.bind(('127.0.0.1', 3334))" >> "$FPO_SCRATCH_DIR/harness-scratch.sh"
set +e
FPO_BIND_TRIP_OUT="$(LIBPATH="$FPO_SCRATCH_DIR/guards-scratch.sh" \
  TARGET="$FPO_SCRATCH_DIR/harness-scratch.sh" bash -c '
    set -euo pipefail
    source "$LIBPATH"
    riso_reintroduction_guard "$TARGET" "scratch-bind" 2>&1
    exit $?
' 2>&1)"
FPO_BIND_TRIP_RC=$?
set -e
if [ "$FPO_BIND_TRIP_RC" -ne 0 ] && printf '%s\n' "$FPO_BIND_TRIP_OUT" | grep -q "VIOLATION (scratch-bind): executed socket bind to a literal production port"; then
  pass "reintroduction guard trips on a scratch copy with a reintroduced production-port bind (rc=$FPO_BIND_TRIP_RC)"
else
  fail "reintroduction guard did NOT trip on the reintroduced bind (rc=$FPO_BIND_TRIP_RC out=$FPO_BIND_TRIP_OUT)"
fi

# (b) a scratch copy with source-checkout state usage reintroduced (an rm
#     that derives a var path from the repo source bin):
cp "$_SRC_BIN/tt-recorder.test.sh" "$FPO_SCRATCH_DIR/harness-scratch-state.sh"
printf '%s\n' 'rm -rf "$_SRC_BIN/../var/recorder" 2>/dev/null || true' >> "$FPO_SCRATCH_DIR/harness-scratch-state.sh"
set +e
FPO_STATE_TRIP_OUT="$(LIBPATH="$FPO_SCRATCH_DIR/guards-scratch.sh" \
  TARGET="$FPO_SCRATCH_DIR/harness-scratch-state.sh" bash -c '
    set -euo pipefail
    source "$LIBPATH"
    riso_reintroduction_guard "$TARGET" "scratch-state" 2>&1
    exit $?
' 2>&1)"
FPO_STATE_TRIP_RC=$?
set -e
if [ "$FPO_STATE_TRIP_RC" -ne 0 ] && printf '%s\n' "$FPO_STATE_TRIP_OUT" | grep -q "VIOLATION (scratch-state): source-checkout state usage"; then
  pass "reintroduction guard trips on a scratch copy with reintroduced source-checkout state usage (rc=$FPO_STATE_TRIP_RC)"
else
  fail "reintroduction guard did NOT trip on the reintroduced checkout-state usage (rc=$FPO_STATE_TRIP_RC out=$FPO_STATE_TRIP_OUT)"
fi

# (c) negative control for the guard itself: a scratch copy with only a
#     harmless comment addition must NOT trip (the guard is not vacuous-
#     always-trip; doc prose mentioning the ports stays masked).
cp "$_SRC_BIN/tt-recorder.test.sh" "$FPO_SCRATCH_DIR/harness-scratch-clean.sh"
printf '%s\n' '# doc prose may mention the literal production ports 3334/3338/3339 and stay unflagged' >> "$FPO_SCRATCH_DIR/harness-scratch-clean.sh"
set +e
FPO_CLEAN_GUARD_OUT="$(LIBPATH="$FPO_SCRATCH_DIR/guards-scratch.sh" \
  TARGET="$FPO_SCRATCH_DIR/harness-scratch-clean.sh" bash -c '
    set -euo pipefail
    source "$LIBPATH"
    riso_reintroduction_guard "$TARGET" "scratch-clean" 2>&1
    exit $?
' 2>&1)"
FPO_CLEAN_GUARD_RC=$?
set -e
if [ "$FPO_CLEAN_GUARD_RC" -eq 0 ]; then
  pass "reintroduction guard does not trip on a harmless comment-only scratch copy"
else
  fail "reintroduction guard tripped on a comment-only scratch copy (rc=$FPO_CLEAN_GUARD_RC out=$FPO_CLEAN_GUARD_OUT)"
fi

# ── Hygiene: only the fixture root registered; no owned children remain ──
echo ""
echo "--- RISO: port-isolation hygiene ---"

FPO_REG_COUNT=0
FPO_REG_FIXTURE=0
for _reg_r in "${_ALLOCATED_ROOTS[@]+"${_ALLOCATED_ROOTS[@]}"}"; do
  [ -n "$_reg_r" ] || continue
  FPO_REG_COUNT=$((FPO_REG_COUNT + 1))
  [ "$_reg_r" = "$FIXTURE_ROOT" ] && FPO_REG_FIXTURE=1
done
if [ "$FPO_REG_COUNT" -eq 1 ] && [ "$FPO_REG_FIXTURE" -eq 1 ]; then
  pass "cleanup registry holds exactly this invocation's fixture root"
else
  fail "cleanup registry is wrong (count=$FPO_REG_COUNT)"
fi

FPO_BAD_LEFT=0
for _t in $OWNED_PIDS; do
  case "$_t" in
    *:*) FPO_BAD_LEFT=$((FPO_BAD_LEFT + 1)) ;;
  esac
done
if [ "$FPO_BAD_LEFT" -eq 0 ]; then
  pass "no owned children remain registered (scenario-owned listeners stopped)"
else
  fail "$FPO_BAD_LEFT owned child/ren still registered"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== RISO US-002 port-isolation regression: all checks passed ==="
  exit 0
else
  echo "=== RISO US-002 port-isolation regression: $FAILURES check(s) FAILED ==="
  exit 1
fi
