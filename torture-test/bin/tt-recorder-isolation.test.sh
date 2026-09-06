#!/usr/bin/env bash
# tt-recorder-isolation.test.sh — RISO US-001 focused isolation regression
# (integration gate) for the tt-recorder recorder self-test repair.
#
# This script is the US-001 integration gate. It sources the SAME guards
# library the full harness sources (bin/tt-recorder-selftest-guards.sh), so
# the guard code it exercises is byte-identical to what the full harness
# ships, and it NEVER runs the full legacy harness. It never touches the
# repo checkout's torture-test/var, never binds or probes production ports,
# and every mutable fixture/process belongs to this invocation.
#
# The PURE pre-execution ownership gate (hostile-name cleanup-registry
# expansion, malformed-allocation zero-removal, pidfile/identity gates —
# with all destructive operations denied/recorded and controlled process
# observations) lives SEPARATELY in bin/tt-recorder-guard-proof.test.sh and
# can run alone; this file is the DISTINCT later gate that additionally
# exercises the recorder's real db/wal evidence path against fixture homes.
#
# What this integration gate proves (each via PASS/FAIL, exit 0 only with
# zero FAIL lines):
#   * the WAL/db size assertions stay EXACT against fixture-written bytes —
#     real-daemon db_size_bytes/wal_size_bytes equal the exact fixture-file
#     byte counts the test wrote; the scripted-daemon wal_size_bytes is 0
#     ONLY because the fixture home-scripted intentionally has no .db-wal
#     (the absent file is asserted, actual fixture contents are compared).
#     Sampling is exercised through the real tool row logic with the
#     TEST-SIDE discovery boundary restricted to the EXACT pids this run
#     owns (the tool's host-wide scan is never run here);
#   * a pre-populated NEIGHBORING synthetic fake-campaign tree (own mktemp
#     root, never the repo var, never the fixture root) with a pre-existing
#     recorder pidfile naming a live sentinel process, sentinel db/wal bytes
#     and an identifiable file survives unchanged: sentinel still alive,
#     files byte-identical (cmp), pidfile byte-identical — a supplied or
#     pre-existing PID file never authorizes killing anything;
#   * only the fixture homes are ever mutated/removed — the fixture-owned
#     recorder state dir and the fixture daemon homes are created, written
#     and removed by this run while the neighbor stays byte-identical;
#   * no owned children survive (exit cleanup stops the sentinel and removes
#     only the recorded roots).
#
# Like the full harness this file is NOT part of the normal
# torture-test/self-tests/run.sh battery (run.sh must not gain this shell
# harness); it is invoked directly when the recorder self-test repair needs
# its integration gate. GNU/Linux-only (bash 3.2-compatible syntax, same as
# the harness family). Kept free of the literal procfs mount so it needs no
# portability-lint allowlist entry of its own.
set -euo pipefail

_SRC_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$_SRC_BIN/tt-recorder-selftest-guards.sh"

riso_bootstrap_fixture tt-recorder-selftest-isolation

echo ""
echo "=== RISO US-001: isolation regression (integration gate) ==="
echo "  fixture root: $FIXTURE_ROOT"

# ── WAL/db exactness (fixture-owned homes; exact bytes, never >=0) ────
echo ""
echo "--- RISO: exact db/wal size assertions on fixture-written bytes ---"

mkdir -p "$TT_ROOT_VAR/home/.tamandua"
mkdir -p "$TT_ROOT_VAR/home-scripted/.tamandua"

printf '%s' 'real-db-content'     > "$TT_ROOT_VAR/home/.tamandua/tamandua.db"
printf '%s' 'real-wal-data-more'  > "$TT_ROOT_VAR/home/.tamandua/tamandua.db-wal"
printf '%s' 'scripted-db'         > "$TT_ROOT_VAR/home-scripted/.tamandua/tamandua.db"
# scripted WAL: intentionally absent — the exact-zero assertion depends on it

REAL_DB_EXPECT="$(wc -c < "$TT_ROOT_VAR/home/.tamandua/tamandua.db")"
REAL_WAL_EXPECT="$(wc -c < "$TT_ROOT_VAR/home/.tamandua/tamandua.db-wal")"
SCRIPTED_DB_EXPECT="$(wc -c < "$TT_ROOT_VAR/home-scripted/.tamandua/tamandua.db")"

# Controlled daemon processes: cwd under the fixture-owned homes. Their pids
# are the ONLY discovery input the sample below is allowed to see.
( cd "$TT_ROOT_VAR/home" && sleep 120 ) &
ISO_REAL_PID=$!
_register_owned "$ISO_REAL_PID"
( cd "$TT_ROOT_VAR/home-scripted" && sleep 120 ) &
ISO_SCRIPTED_PID=$!
_register_owned "$ISO_SCRIPTED_PID"

sleep 0.5

# Restricted test-side discovery boundary: sample through the REAL tool row
# logic (collect_sample -> _detect_daemon_db/file_size/JSON emission — the
# recorder's policy is unchanged) but feed it EXACTLY this run's owned pids
# by replacing the host-wide _find_pids scan with an exact-pid list. No
# whole-host scan, no unrelated process rows, no RJSON exposure.
ISO_SAMPLES="$(bash -c "
  set -euo pipefail
  source '$TOOL'
  _find_pids() { printf '%s\n' '$ISO_REAL_PID' '$ISO_SCRIPTED_PID'; }
  collect_sample
" 2>/dev/null || true)"

# Parse the exact fields for each fixture daemon from the real tool output.
ISO_REAL_FIELDS="$(printf '%s\n' "$ISO_SAMPLES" | python3 -c "
import json,sys
want=$ISO_REAL_PID
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    o=json.loads(line)
    if o.get('pid') == want:
        print(o.get('db_size_bytes','MISSING'), o.get('wal_size_bytes','MISSING'), o.get('db_path','MISSING'))
        break
" 2>/dev/null || true)"

ISO_SCRIPTED_FIELDS="$(printf '%s\n' "$ISO_SAMPLES" | python3 -c "
import json,sys
want=$ISO_SCRIPTED_PID
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    o=json.loads(line)
    if o.get('pid') == want:
        print(o.get('db_size_bytes','MISSING'), o.get('wal_size_bytes','MISSING'), o.get('db_path','MISSING'))
        break
" 2>/dev/null || true)"

ISO_REAL_DB="$(printf '%s\n' "$ISO_REAL_FIELDS" | awk '{print $1}')"
ISO_REAL_WAL="$(printf '%s\n' "$ISO_REAL_FIELDS" | awk '{print $2}')"
ISO_REAL_PATH="$(printf '%s\n' "$ISO_REAL_FIELDS" | awk '{print $3}')"
ISO_SCRIPTED_DB="$(printf '%s\n' "$ISO_SCRIPTED_FIELDS" | awk '{print $1}')"
ISO_SCRIPTED_WAL="$(printf '%s\n' "$ISO_SCRIPTED_FIELDS" | awk '{print $2}')"
ISO_SCRIPTED_PATH="$(printf '%s\n' "$ISO_SCRIPTED_FIELDS" | awk '{print $3}')"

if [ -n "$ISO_REAL_DB" ] && [ "$ISO_REAL_DB" != "MISSING" ] && [ "$ISO_REAL_DB" = "$REAL_DB_EXPECT" ]; then
  pass "WAL exactness: real daemon db_size_bytes ($ISO_REAL_DB) equals the exact fixture bytes ($REAL_DB_EXPECT)"
else
  fail "WAL exactness: real daemon db_size_bytes ('$ISO_REAL_DB') != exact fixture bytes ($REAL_DB_EXPECT)"
fi

if [ -n "$ISO_REAL_WAL" ] && [ "$ISO_REAL_WAL" != "MISSING" ] && [ "$ISO_REAL_WAL" = "$REAL_WAL_EXPECT" ]; then
  pass "WAL exactness: real daemon wal_size_bytes ($ISO_REAL_WAL) equals the exact fixture bytes ($REAL_WAL_EXPECT)"
else
  fail "WAL exactness: real daemon wal_size_bytes ('$ISO_REAL_WAL') != exact fixture bytes ($REAL_WAL_EXPECT)"
fi

if [ -n "$ISO_SCRIPTED_DB" ] && [ "$ISO_SCRIPTED_DB" != "MISSING" ] && [ "$ISO_SCRIPTED_DB" = "$SCRIPTED_DB_EXPECT" ]; then
  pass "WAL exactness: scripted daemon db_size_bytes ($ISO_SCRIPTED_DB) equals the exact fixture bytes ($SCRIPTED_DB_EXPECT)"
else
  fail "WAL exactness: scripted daemon db_size_bytes ('$ISO_SCRIPTED_DB') != exact fixture bytes ($SCRIPTED_DB_EXPECT)"
fi

# Exact-zero WAL: 0 only because the fixture home-scripted has NO .db-wal —
# assert the absence AND the recorded zero, never an always-true condition.
if [ ! -e "$TT_ROOT_VAR/home-scripted/.tamandua/tamandua.db-wal" ]; then
  pass "WAL exactness: fixture home-scripted intentionally has no .db-wal (absence asserted)"
else
  fail "WAL exactness: fixture home-scripted unexpectedly has a .db-wal"
fi

if [ -n "$ISO_SCRIPTED_WAL" ] && [ "$ISO_SCRIPTED_WAL" = "0" ]; then
  pass "WAL exactness: scripted daemon wal_size_bytes == 0 (absent fixture WAL)"
else
  fail "WAL exactness: scripted daemon wal_size_bytes ('$ISO_SCRIPTED_WAL') is not 0"
fi

# db_paths are fixture-owned and distinguish real vs scripted homes
if [ "$ISO_REAL_PATH" = "$TT_ROOT_VAR/home/.tamandua/tamandua.db" ]; then
  pass "WAL exactness: real daemon db_path is the fixture home/.tamandua db"
else
  fail "WAL exactness: real daemon db_path ('$ISO_REAL_PATH') is not the fixture home db"
fi
if [ "$ISO_SCRIPTED_PATH" = "$TT_ROOT_VAR/home-scripted/.tamandua/tamandua.db" ]; then
  pass "WAL exactness: scripted daemon db_path is the fixture home-scripted/.tamandua db"
else
  fail "WAL exactness: scripted daemon db_path ('$ISO_SCRIPTED_PATH') is not the fixture home-scripted db"
fi

# Stop the WAL-arm dummies (identity-verified). The fixture homes they wrote
# are removed by this invocation's exit cleanup along with the fixture root.
_stop_registered_pid "$ISO_REAL_PID"
_stop_registered_pid "$ISO_SCRIPTED_PID"

# ── Neighbor fake-campaign tree + sentinel (wholly synthetic, self-owned) ─
echo ""
echo "--- RISO: pre-populated neighbor tree + sentinel survival ---"

NEIGHBOR_ROOT="$(_riso_new_root tt-recorder-neighbor)"
_ALLOCATED_ROOTS+=("$NEIGHBOR_ROOT")
mkdir -p "$NEIGHBOR_ROOT/torture-test/var/recorder"
mkdir -p "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua"
mkdir -p "$NEIGHBOR_ROOT/torture-test/var/home-scripted/.tamandua"
NEIGHBOR_SENTINEL_DIR="$NEIGHBOR_ROOT/torture-test/var/home/sentinel-cwd-$$"
mkdir -p "$NEIGHBOR_SENTINEL_DIR"

printf '%s' 'neighbor-real-db-sentinel'     > "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/tamandua.db"
printf '%s' 'neighbor-real-wal-sentinel'    > "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/tamandua.db-wal"
printf '%s' 'neighbor-scripted-db-sentinel' > "$NEIGHBOR_ROOT/torture-test/var/home-scripted/.tamandua/tamandua.db"
printf '%s' 'neighbor-identifiable-sentinel' > "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/identifiable-file"

# Sentinel process: a sleep whose cwd sits inside the neighbor var/home
# subtree (like a live contained campaign daemon). Registered as owned so
# exit cleanup stops it (identity-rechecked) and removes the neighbor root.
( cd "$NEIGHBOR_SENTINEL_DIR" && sleep 600 ) &
ISO_SENTINEL_PID=$!
_register_owned "$ISO_SENTINEL_PID"

# Pre-existing neighbor pidfile pointing at the sentinel — a pre-existing
# PID file must NEVER authorize killing anything.
printf '%s\n' "$ISO_SENTINEL_PID" > "$NEIGHBOR_ROOT/torture-test/var/recorder/tt-recorder.pid"

mkdir -p "$FIXTURE_ROOT/isolation-baseline"
cp "$NEIGHBOR_ROOT/torture-test/var/recorder/tt-recorder.pid" "$FIXTURE_ROOT/isolation-baseline/neighbor.pidfile"
cp "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/tamandua.db" "$FIXTURE_ROOT/isolation-baseline/neighbor-real.db"
cp "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/tamandua.db-wal" "$FIXTURE_ROOT/isolation-baseline/neighbor-real.db-wal"
cp "$NEIGHBOR_ROOT/torture-test/var/home-scripted/.tamandua/tamandua.db" "$FIXTURE_ROOT/isolation-baseline/neighbor-scripted.db"
cp "$NEIGHBOR_ROOT/torture-test/var/home/.tamandua/identifiable-file" "$FIXTURE_ROOT/isolation-baseline/neighbor-identifiable-file"

# Hazard pass: a FIXTURE-owned pidfile naming the NEIGHBOR sentinel PID must
# never authorize a signal — recorder evidence (fixture-tool cmdline +
# fixture cwd) fails for the sentinel, so teardown signals nothing. Under the
# deny-and-record signal seam, zero signals are even recorded; the sentinel
# must still be alive afterwards (the old startup cleanup killed exactly this
# pidfile-PID class).
ISO_FAKE_PIDFILE="$TT_ROOT_VAR/recorder/tt-recorder.pid"
rm -rf "$TT_ROOT_VAR/recorder" 2>/dev/null || true
mkdir -p "$TT_ROOT_VAR/recorder"
printf '%s\n' "$ISO_SENTINEL_PID" > "$ISO_FAKE_PIDFILE"
ISO_SEAM_LOG="$FIXTURE_ROOT/riso-isolation-signal-log.txt"
rm -f -- "$ISO_SEAM_LOG"
_SELFTEST_SIGNAL_LOG="$ISO_SEAM_LOG"
_teardown_recorder_pidfile "$ISO_FAKE_PIDFILE" 2>/dev/null || true
_SELFTEST_SIGNAL_LOG=""
if kill -0 "$ISO_SENTINEL_PID" 2>/dev/null && [ ! -s "$ISO_SEAM_LOG" ]; then
  pass "pre-existing pidfile PID never signals: sentinel alive, zero signals recorded"
else
  fail "pre-existing pidfile PID authorized a signal or killed the sentinel"
fi

# Fixture state churn mirroring the old harness's per-section behavior — all
# against the FIXTURE-owned recorder dir and homes (never the neighbor): a
# recorder-style state dir is created and removed, and the fixture daemon
# homes are re-written and removed, proving only fixture paths are mutable.
ISO_RECORDER_DIR="$TT_ROOT_VAR/recorder"
rm -rf "$ISO_RECORDER_DIR" 2>/dev/null || true
mkdir -p "$ISO_RECORDER_DIR"
printf '%s\n' "$ISO_SENTINEL_PID" > "$ISO_RECORDER_DIR/tt-recorder.pid"
rm -rf "$ISO_RECORDER_DIR" 2>/dev/null || true
rm -rf "$TT_ROOT_VAR/home" 2>/dev/null || true
rm -rf "$TT_ROOT_VAR/home-scripted" 2>/dev/null || true
mkdir -p "$TT_ROOT_VAR/home/.tamandua"
printf '%s' 'fixture-churn-real' > "$TT_ROOT_VAR/home/.tamandua/tamandua.db"
rm -rf "$TT_ROOT_VAR/home" 2>/dev/null || true

# Sentinel survival + byte-identity of the whole neighbor tree.
if kill -0 "$ISO_SENTINEL_PID" 2>/dev/null; then
  pass "isolation: neighbor sentinel process still alive (pid=$ISO_SENTINEL_PID)"
else
  fail "isolation: neighbor sentinel process was killed (pid=$ISO_SENTINEL_PID)"
fi

if cmp -s "$NEIGHBOR_ROOT/torture-test/var/recorder/tt-recorder.pid" "$FIXTURE_ROOT/isolation-baseline/neighbor.pidfile"; then
  pass "isolation: neighbor recorder pidfile byte-identical (unchanged)"
else
  fail "isolation: neighbor recorder pidfile changed"
fi

ISO_FILES_OK=1
for _pair in \
  "torture-test/var/home/.tamandua/tamandua.db:isolation-baseline/neighbor-real.db" \
  "torture-test/var/home/.tamandua/tamandua.db-wal:isolation-baseline/neighbor-real.db-wal" \
  "torture-test/var/home-scripted/.tamandua/tamandua.db:isolation-baseline/neighbor-scripted.db" \
  "torture-test/var/home/.tamandua/identifiable-file:isolation-baseline/neighbor-identifiable-file"; do
  if ! cmp -s "$NEIGHBOR_ROOT/${_pair%%:*}" "$FIXTURE_ROOT/${_pair#*:}"; then
    ISO_FILES_OK=0
  fi
done
if [ "$ISO_FILES_OK" -eq 1 ]; then
  pass "isolation: all neighbor sentinel files byte-identical (cmp)"
else
  fail "isolation: a neighbor sentinel file changed"
fi

# The live cleanup registry holds exactly this invocation's two roots.
ISO_REG_COUNT=0
ISO_REG_FIXTURE=0
ISO_REG_NEIGHBOR=0
for _reg_r in "${_ALLOCATED_ROOTS[@]+"${_ALLOCATED_ROOTS[@]}"}"; do
  [ -n "$_reg_r" ] || continue
  ISO_REG_COUNT=$((ISO_REG_COUNT + 1))
  [ "$_reg_r" = "$FIXTURE_ROOT" ] && ISO_REG_FIXTURE=1
  [ "$_reg_r" = "$NEIGHBOR_ROOT" ] && ISO_REG_NEIGHBOR=1
done
if [ "$ISO_REG_COUNT" -eq 2 ] && [ "$ISO_REG_FIXTURE" -eq 1 ] && [ "$ISO_REG_NEIGHBOR" -eq 1 ]; then
  pass "cleanup registry holds exactly the fixture and the neighbor (nothing else)"
else
  fail "cleanup registry is wrong (count=$ISO_REG_COUNT)"
fi

# Only the sentinel may remain registered — every scenario stopped its own
# children; exit cleanup stops the sentinel and removes the recorded roots.
ISO_BAD_LEFT=0
for _t in $OWNED_PIDS; do
  case "$_t" in
    "$ISO_SENTINEL_PID":*) ;;
    *) ISO_BAD_LEFT=$((ISO_BAD_LEFT + 1)) ;;
  esac
done
if [ "$ISO_BAD_LEFT" -eq 0 ]; then
  pass "only the sentinel remains registered (all scenario-owned children stopped)"
else
  fail "$ISO_BAD_LEFT unexpected registered child/ren remain"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== RISO US-001 isolation regression: all checks passed ==="
  exit 0
else
  echo "=== RISO US-001 isolation regression: $FAILURES check(s) FAILED ==="
  exit 1
fi
