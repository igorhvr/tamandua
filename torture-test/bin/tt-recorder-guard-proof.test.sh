#!/usr/bin/env bash
# tt-recorder-guard-proof.test.sh — RISO US-001 PURE guard-only proof.
#
# This is the pre-execution ownership gate: it proves the ownership/fixture
# guard code (bin/tt-recorder-selftest-guards.sh — the SAME library the full
# legacy harness and the isolation regression source) is safe BEFORE anyone
# runs the full harness end-to-end. It is deliberately PURE:
#
#   * NO host-wide process sampling (no collect_sample, no discover_processes);
#   * NO real recorder start (no tt-recorder start / run-loop);
#   * ALL destructive operations denied/recorded — the cleanup-registry
#     expansion is exercised through an UNCONDITIONAL recording removal stub
#     (exact argv bytes preserved, nothing deleted); allocation rejection is
#     proven with a deny-and-record removal boundary installed AFTER sourcing
#     plus an unconditional recording `rm` stub (even a direct rm regression
#     cannot execute);
#   * controlled process observations only — every observed process is a
#     child this proof itself spawned under its own fixture and stopped;
#   * every mutable fixture root is freshly allocated and owned by this
#     invocation; exit cleanup removes only the recorded roots.
#
# What it proves (each via PASS/FAIL, exit 0 only with zero FAIL lines):
#   * hostile-name cleanup-registry expansion (spaces/tabs/newlines/glob
#     bytes) issues exactly ONE recorded rm whose argv is byte-identical to
#     "-rf -- <whole owned root>" — a word-splitting or glob-expanding
#     registry multiplies calls or changes path bytes and fails the
#     byte-exact assertion;
#   * malformed/untrusted allocation responses (a successful-but-malformed
#     fake allocator printing an out-of-base path, an outright allocation
#     failure, a valid-looking root printed by a FAILING allocator — RISO
#     US-002 follow-up — and a traversal lookalike passing the lexical
#     prefix — RISO US-002 follow-up) cause ZERO removal calls — the real
#     allocator is reached (reached-marker), the sentinel it named survives,
#     and both the deny-and-record removal boundary and an unconditional
#     recording `rm` stub stay empty (even a direct rm regression cannot
#     execute);
#   * inherited cleanup-root markers are cleared at guards source time and
#     can never name a deletion root; the live registry holds exactly this
#     invocation's allocated roots;
#   * a supplied or pre-existing PID file never authorizes killing an
#     unrelated process (out-of-fixture pidfile refused; a fixture pidfile
#     naming a foreign live process records zero signals); detached
#     recorder-style processes are stopped only after cmdline/cwd/identity
#     evidence matches, and a changed identity is never signaled;
#   * no owned children survive — exit cleanup stops every registered child
#     (identity-rechecked) and removes only the recorded roots.
#
# Like the other recorder self-test files this is NOT part of the normal
# torture-test/self-tests/run.sh battery; it is invoked directly as the
# guard-only gate (bash torture-test/bin/tt-recorder-guard-proof.test.sh).
# GNU/Linux-only (bash 3.2-compatible syntax, same as the harness family).
# Kept free of the literal procfs mount so it needs no portability-lint
# allowlist entry of its own.
set -euo pipefail

_SRC_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$_SRC_BIN/tt-recorder-selftest-guards.sh"

# Fresh invocation-owned fixture (mirrors the real tool so $TOOL is the
# exact fixture path evidence checks compare against; no recorder is ever
# started here).
riso_bootstrap_fixture tt-recorder-guard-proof

echo ""
echo "=== RISO US-001: pure guard-only proof (ownership + cleanup registry) ==="
echo "  fixture root: $FIXTURE_ROOT"

# ── Hostile-name cleanup-registry expansion (recording stub, no deletion) ─
echo ""
echo "--- RISO: cleanup registry expansion under hostile path bytes ---"

GPROOF_HOSTILE_PARENT="$FIXTURE_ROOT/hostile-cases"
mkdir -p "$GPROOF_HOSTILE_PARENT"
riso_case_hostile_cleanup "$GPROOF_HOSTILE_PARENT" $'sp ace'    "$GPROOF_HOSTILE_PARENT/sp"  "space"
riso_case_hostile_cleanup "$GPROOF_HOSTILE_PARENT" $'tab\tbase' "$GPROOF_HOSTILE_PARENT/tab"  "tab"
riso_case_hostile_cleanup "$GPROOF_HOSTILE_PARENT" $'nl\nbase'  "$GPROOF_HOSTILE_PARENT/nl"   "newline"
riso_case_hostile_cleanup "$GPROOF_HOSTILE_PARENT" $'f?[o]o glob' "$GPROOF_HOSTILE_PARENT/fxo" "glob"

# ── Malformed allocation → zero removal calls (both response classes) ────
echo ""
echo "--- RISO: malformed allocation rejection (zero removal calls) ---"

riso_case_malformed_allocation "$GPROOF_HOSTILE_PARENT" "malformed-success" malformed
riso_case_malformed_allocation "$GPROOF_HOSTILE_PARENT" "alloc-failure" fail
riso_case_malformed_allocation "$GPROOF_HOSTILE_PARENT" "alloc-exit-7" badrc
riso_case_malformed_allocation "$GPROOF_HOSTILE_PARENT" "traversal-lookalike" traversal

# ── Inherited markers + live registry ─────────────────────────────────
echo ""
echo "--- RISO: inherited markers and the live cleanup registry ---"

# An inherited marker of a cleanup-root name can never choose a deletion
# root: the REAL guards' source-time init clears exported FIXTURE_ROOT /
# NEIGHBOR_ROOT / _ALLOCATED_ROOTS and both seam variables before any
# allocation, and allocation then stays fresh under the real _riso_new_root.
GPROOF_MARKER_ROOT="$(mktemp -d "$_fixbase/tt-recorder-neighbor.inherited-$$.XXXXXX")"
printf '%s' 'inherited-marker-sentinel' > "$GPROOF_MARKER_ROOT/keep-me"
set +e
GPROOF_FRESH_ALLOC="$(MARKER="$GPROOF_MARKER_ROOT" LIBPATH="$_SRC_BIN/tt-recorder-selftest-guards.sh" bash -c '
  set -euo pipefail
  export FIXTURE_ROOT="$MARKER" NEIGHBOR_ROOT="$MARKER"
  export _ALLOCATED_ROOTS="$MARKER"
  export _SELFTEST_SIGNAL_LOG="$MARKER/external-seam" _SELFTEST_RM_LOG="$MARKER/external-rm"
  source "$LIBPATH"
  if [ -n "$FIXTURE_ROOT" ] || [ -n "$NEIGHBOR_ROOT" ] || \
     [ -n "$_SELFTEST_SIGNAL_LOG" ] || [ -n "$_SELFTEST_RM_LOG" ] || \
     [ "${#_ALLOCATED_ROOTS[@]}" -ne 0 ]; then
    exit 8
  fi
  r="$(_riso_new_root tt-recorder-selftest)"
  case "$r" in "$_fixbase"/tt-recorder-selftest.*) ;; *) exit 9 ;; esac
  printf "%s" "$r"
')"
GPROOF_FRESH_ALLOC_RC=$?
set -e
if [ "$GPROOF_FRESH_ALLOC_RC" -eq 0 ] && [ -n "$GPROOF_FRESH_ALLOC" ] && [ "$GPROOF_FRESH_ALLOC" != "$GPROOF_MARKER_ROOT" ] && [ -f "$GPROOF_MARKER_ROOT/keep-me" ]; then
  pass "inherited marker env cleared at guards source time — real allocation stays fresh"
else
  fail "inherited cleanup-root marker influenced allocation (rc=$GPROOF_FRESH_ALLOC_RC)"
fi
if [ -n "$GPROOF_FRESH_ALLOC" ]; then
  case "$GPROOF_FRESH_ALLOC" in
    "$_fixbase"/tt-recorder-selftest.*) rm -rf -- "$GPROOF_FRESH_ALLOC" ;;
  esac
fi
case "$GPROOF_MARKER_ROOT" in
  "$_fixbase"/tt-recorder-neighbor.inherited-*) rm -rf -- "$GPROOF_MARKER_ROOT" ;;
esac

# Live registry: at this point exactly the fixture root (hostile/malformed
# cases ran on private registry copies and restored this one).
GPROOF_REG_COUNT=0
GPROOF_REG_FIXTURE=0
for _reg_r in "${_ALLOCATED_ROOTS[@]+"${_ALLOCATED_ROOTS[@]}"}"; do
  [ -n "$_reg_r" ] || continue
  GPROOF_REG_COUNT=$((GPROOF_REG_COUNT + 1))
  [ "$_reg_r" = "$FIXTURE_ROOT" ] && GPROOF_REG_FIXTURE=1
done
if [ "$GPROOF_REG_COUNT" -eq 1 ] && [ "$GPROOF_REG_FIXTURE" -eq 1 ]; then
  pass "live cleanup registry holds exactly this invocation's fixture root"
else
  fail "live cleanup registry is wrong (count=$GPROOF_REG_COUNT)"
fi

# ── PID-file trust and identity gates (controlled observations only) ────
echo ""
echo "--- RISO: pidfile trust + process identity gates ---"

# A fixture pidfile naming a FOREIGN live process (a plain child of this
# proof — not a recorder) must record ZERO signals: cmdline/cwd evidence
# never matches the fixture recorder tool. Deny-and-record seam proves no
# signal was even intended; the child stays alive.
( cd "$FIXTURE_ROOT" && sleep 300 ) &
GPROOF_FOREIGN_PID=$!
_register_owned "$GPROOF_FOREIGN_PID"
sleep 0.2
GPROOF_PIDFILE="$FIXTURE_ROOT/recorder/tt-recorder.pid"
mkdir -p "$FIXTURE_ROOT/recorder"
printf '%s\n' "$GPROOF_FOREIGN_PID" > "$GPROOF_PIDFILE"
GPROOF_SEAM_LOG="$FIXTURE_ROOT/riso-guard-proof-signal-log.txt"
rm -f -- "$GPROOF_SEAM_LOG"
_SELFTEST_SIGNAL_LOG="$GPROOF_SEAM_LOG"
_teardown_recorder_pidfile "$GPROOF_PIDFILE" 2>/dev/null || true
_SELFTEST_SIGNAL_LOG=""
if kill -0 "$GPROOF_FOREIGN_PID" 2>/dev/null && [ ! -s "$GPROOF_SEAM_LOG" ]; then
  pass "fixture pidfile naming a foreign process records zero signals; process untouched"
else
  fail "a pidfile PID authorized a signal against a foreign process"
fi

# Out-of-fixture pidfile teardown is refused (deletes nothing, signals
# nothing) — cleanup never traverses outside the exact fixture paths.
GPROOF_EXTRA_ROOT="$(_riso_new_root tt-recorder-guard-proof-extra)"
_ALLOCATED_ROOTS+=("$GPROOF_EXTRA_ROOT")
printf '%s\n' "$GPROOF_FOREIGN_PID" > "$GPROOF_EXTRA_ROOT/tt-recorder.pid"
set +e
GPROOF_EXTRA_OUT="$(_teardown_recorder_pidfile "$GPROOF_EXTRA_ROOT/tt-recorder.pid" 2>&1)"
GPROOF_EXTRA_RC=$?
set -e
if [ "$GPROOF_EXTRA_RC" -ne 0 ] && [ -f "$GPROOF_EXTRA_ROOT/tt-recorder.pid" ] && kill -0 "$GPROOF_FOREIGN_PID" 2>/dev/null; then
  pass "out-of-fixture pidfile is refused — nothing removed, process untouched"
else
  fail "out-of-fixture pidfile was not refused (rc=$GPROOF_EXTRA_RC)"
fi
_stop_registered_pid "$GPROOF_FOREIGN_PID"

# A stale/changed registry identity never authorizes a signal — even when
# the process is alive (registry entry corrupted to a bogus start token).
( cd "$FIXTURE_ROOT" && sleep 300 ) &
GPROOF_STALE_PID=$!
_register_owned "$GPROOF_STALE_PID"
sleep 0.2
_unregister_owned "$GPROOF_STALE_PID"
OWNED_PIDS="$OWNED_PIDS $GPROOF_STALE_PID:bogus-token"
GPROOF_SEAM_LOG2="$FIXTURE_ROOT/riso-guard-proof-signal-log-2.txt"
rm -f -- "$GPROOF_SEAM_LOG2"
_SELFTEST_SIGNAL_LOG="$GPROOF_SEAM_LOG2"
_stop_registered_pid "$GPROOF_STALE_PID"
_SELFTEST_SIGNAL_LOG=""
if kill -0 "$GPROOF_STALE_PID" 2>/dev/null && [ ! -s "$GPROOF_SEAM_LOG2" ]; then
  pass "stale/changed registry identity never signals (nothing recorded, process alive)"
else
  fail "stale/changed registry identity authorized a signal"
fi
_register_owned "$GPROOF_STALE_PID"
_stop_registered_pid "$GPROOF_STALE_PID"

# Detached-recorder teardown: a child whose cmdline carries the EXACT
# fixture tool path and whose cwd is under the fixture passes evidence, is
# stopped only with identity re-attested per signal, and a changed identity
# with the same evidence is refused. (Synthetic evidence-matching child —
# controlled observation; no real recorder is started.)
( cd "$FIXTURE_ROOT" && exec -a "$TOOL" sleep 300 ) &
GPROOF_REC_PID=$!
_register_owned "$GPROOF_REC_PID"
sleep 0.2
GPROOF_REC_TOK="$(_proc_starttok "$GPROOF_REC_PID")"
if [ -n "$GPROOF_REC_TOK" ] && _recorder_identity_ok "$GPROOF_REC_PID" "$GPROOF_REC_TOK"; then
  pass "recorder evidence gate accepts the attested fixture-tool child"
else
  fail "recorder evidence gate rejected the attested fixture-tool child"
fi
if _recorder_identity_ok "$GPROOF_REC_PID" "changed-identity-token"; then
  fail "recorder identity gate accepted a changed/reused identity"
else
  pass "recorder identity gate refuses a changed identity (same cmdline/cwd evidence)"
fi
# deny-and-record teardown of the evidence-matching child: TERM+KILL must be
# recorded, nothing delivered, then real teardown stops it.
GPROOF_SEAM_LOG3="$FIXTURE_ROOT/riso-guard-proof-signal-log-3.txt"
rm -f -- "$GPROOF_SEAM_LOG3"
_SELFTEST_SIGNAL_LOG="$GPROOF_SEAM_LOG3"
_recorder_teardown_pid "$GPROOF_REC_PID"
_SELFTEST_SIGNAL_LOG=""
if grep -q "signal -TERM $GPROOF_REC_PID" "$GPROOF_SEAM_LOG3" 2>/dev/null && \
   grep -q "signal -KILL $GPROOF_REC_PID" "$GPROOF_SEAM_LOG3" 2>/dev/null && \
   kill -0 "$GPROOF_REC_PID" 2>/dev/null; then
  pass "deny-and-record recorder teardown recorded TERM+KILL, delivered nothing"
else
  fail "deny-and-record recorder teardown did not record TERM+KILL"
fi
_teardown_recorder_pidfile "$FIXTURE_ROOT/recorder/tt-recorder.pid" 2>/dev/null || true
_stop_registered_pid "$GPROOF_REC_PID"
if ! kill -0 "$GPROOF_REC_PID" 2>/dev/null; then
  pass "evidence-matching child really stopped after seam cleared (identity re-attested)"
else
  fail "evidence-matching child still alive after real teardown"
fi

# ── No owned children survive ─────────────────────────────────────────
GPROOF_BAD_LEFT=0
for _t in $OWNED_PIDS; do
  case "$_t" in
    *:*) GPROOF_BAD_LEFT=$((GPROOF_BAD_LEFT + 1)) ;;
  esac
done
if [ "$GPROOF_BAD_LEFT" -eq 0 ]; then
  pass "no owned children remain registered (all proof-owned children stopped)"
else
  fail "$GPROOF_BAD_LEFT owned child/ren still registered"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== RISO US-001 guard-only proof: all checks passed ==="
  exit 0
else
  echo "=== RISO US-001 guard-only proof: $FAILURES check(s) FAILED ==="
  exit 1
fi
