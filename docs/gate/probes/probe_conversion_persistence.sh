#!/bin/bash
# probe_conversion_persistence.sh — prove whether an existing WAL state.db,
# converted OFFLINE on a copy to rollback journal, stays rollback after the next
# writer starts.
#
# This is the central rollout question: hermes never live-downgrades an existing
# WAL store, so conversion is an offline act; the risk is that the next writer
# reverses it.  The probe answers it with a real seeded store, the supported
# offline conversion command, and the real writer.
#
# Flow (every directory is disposable, under a mktemp-created /tmp/g1-* root):
#
#   1. seed-wal/home       database.journal_mode: wal
#                          SessionDB() + create_session() -> state.db header 2,2
#                          record sha256 of the original (ORIGINAL_SHA)
#   2. conversion/state.db cp -a of the original; sha256 + cmp prove it is a
#                          byte-identical copy before conversion
#   3. conversion          `hermes sessions set-journal-mode delete --db
#                          <copy>` (the supported offline path) -> header 1,1;
#                          re-hash the original and prove ORIGINAL_SHA unchanged
#   4. delete/home         database.journal_mode: delete; place the converted
#                          copy as state.db; run the writer TWICE; read the
#                          header after each close.  Both must be 1,1.
#   5. wal-control/home    database.journal_mode: wal; place the SAME converted
#                          copy as state.db; run the writer ONCE; the header
#                          returns to 2,2.  This control proves the configured
#                          mode (not the conversion) decides the next open.
#
# Journal format is read ONLY with read_header.py (raw bytes 18/19).  No SQLite
# connection is opened by this probe to inspect a journal mode: a connection can
# checkpoint a WAL and change the thing being measured.
#
# Usage:
#   ./probe_conversion_persistence.sh
#
# Environment:
#   HERMES_SRC            installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_CONVERSION_ROOT    reuse a caller-created /tmp/g1-* root instead of mktemp
#   G1_KEEP_SCRATCH       set to 1 to keep a self-created root for inspection
#
# Safety: every home lives under the disposable scratch root, HOME is redirected
# into that scratch tree, and every Hermes CLI call goes through
# hermes_scratch.sh, which hard-refuses /home/kaladin/.hermes.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$PROBES_DIR/../../.." && pwd)"
WRAPPER="$PROBES_DIR/hermes_scratch.sh"
READ_HEADER="$PROBES_DIR/read_header.py"

HERMES_SRC="${HERMES_SRC:-/home/kaladin/hermes-agent}"
PYTHON="${HERMES_SRC}/venv/bin/python"
HERMES_BIN="${HERMES_SRC}/venv/bin/hermes"
REAL_HOME="/home/kaladin/.hermes"

for required in "$WRAPPER" "$READ_HEADER" "$PYTHON" "$HERMES_BIN"; do
  if [ ! -e "$required" ]; then
    printf 'probe_conversion_persistence: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

if [ -n "${G1_CONVERSION_ROOT:-}" ]; then
  ROOT="$G1_CONVERSION_ROOT"
  mkdir -p "$ROOT"
  KEEP=1
else
  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-conversion.XXXXXX")" || exit 2
  if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
    KEEP=1
  else
    KEEP=0
    trap 'rm -rf -- "$ROOT"' EXIT
  fi
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'probe_conversion_persistence: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
    exit 64
    ;;
esac

# A scratch HOME removes the last Path.home() fallback path to ~/.hermes.
OPERATOR_HOME="$ROOT/operator-home"
mkdir -p "$OPERATOR_HOME"
export HOME="$OPERATOR_HOME"

# Never inherit a store-routing or journal-mode override from the invoking
# daemon.  HERMES_JOURNAL_MODE is not a config layer (US-002), but unset it
# anyway so the probe can never be steered by the environment.
unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_VERIFY_ON_STOP HERMES_JOURNAL_MODE

FAILURES=0

note() { printf '%s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); printf 'ASSERT FAIL: %s\n' "$*"; }
pass() { printf 'ASSERT PASS: %s\n' "$*"; }

write_config() {
  local home="$1" mode="$2"
  mkdir -p "$home"
  printf 'database:\n  journal_mode: %s\n' "$mode" > "$home/config.yaml"
}

# Confirm the home resolves to the intended mode before the writer runs.  This
# is an in-process read of the configured value, not a journal-mode query.
confirm_resolved_mode() {
  local home="$1" expected="$2" actual
  actual="$( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
    'from hermes_state_wal import resolve_journal_mode; print(resolve_journal_mode())' 2>/dev/null )"
  if [ "$actual" = "$expected" ]; then
    pass "$(basename "$(dirname "$home")") resolves database.journal_mode=$expected before the writer"
  else
    fail "$(basename "$(dirname "$home")") resolved '$actual', expected '$expected' before the writer"
  fi
}

json_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$field"
}

sha256_of() {
  sha256sum -- "$1" | awk '{print $1}'
}

# Read one file's header with read_header.py only and print every field the
# story requires: sha256, byte18/byte19, mode, size, and sidecars.
measure() {
  local label="$1" db="$2" header_json size sha byte18 byte19 mode dir base
  dir="$(dirname -- "$db")"
  base="$(basename -- "$db")"
  if [ ! -f "$db" ]; then
    fail "$label: store does not exist at $db"
    return 1
  fi
  header_json="$("$PYTHON" "$READ_HEADER" "$db" 2>/dev/null)" || {
    fail "$label: read_header.py failed on $db"
    return 1
  }
  size="$(json_field "$header_json" size)"
  sha="$(json_field "$header_json" sha256)"
  byte18="$(json_field "$header_json" byte18)"
  byte19="$(json_field "$header_json" byte19)"
  mode="$(json_field "$header_json" mode)"
  note "header_json: $header_json"
  note "${label}_path: $db"
  note "${label}_size: $size"
  note "${label}_sha256: $sha"
  note "${label}_byte18: $byte18"
  note "${label}_byte19: $byte19"
  note "${label}_observed_mode: $mode"
  note "${label}_journal_sidecars:"
  local sidecars
  sidecars="$(find "$dir" -maxdepth 1 -type f \
    \( -name "$base-wal" -o -name "$base-shm" -o -name "$base-journal" \) \
    -printf '%f\t%s\n' 2>/dev/null | sort)"
  if [ -z "$sidecars" ]; then note "  (none)"; else printf '%s\n' "$sidecars" | sed 's/^/  /'; fi
  note "${label}_related_files (ls -la, store prefix only):"
  find "$dir" -maxdepth 1 -type f -name "$base*" -printf '%M\t%10s\t%f\n' 2>/dev/null \
    | sort | sed 's/^/  /'
  printf '%s %s %s %s\n' "$sha" "$byte18" "$byte19" "$mode" > "$ROOT/.measure-result"
  printf '%s %s %s %s\n' "$sha" "$byte18" "$byte19" "$mode"
}

# measure_assert <label> <db> <expected "b18 b19"> <expected-mode>
# Prints the measurement and increments FAILURES on a mismatch.  The parsed
# field line is read from $ROOT/.measure-result because measure() also prints
# the human-readable evidence lines to stdout.
measure_assert() {
  local label="$1" db="$2" expected_pair="$3" expected_mode="$4" measured sha byte18 byte19 mode
  measure "$label" "$db" || return 1
  measured="$(cat "$ROOT/.measure-result")"
  read -r sha byte18 byte19 mode <<< "$measured"
  if [ "$byte18 $byte19" = "$expected_pair" ] && [ "$mode" = "$expected_mode" ]; then
    pass "$label header is $byte18,$byte19 (mode $mode)"
  else
    fail "$label header is $byte18,$byte19 (mode $mode), expected $expected_pair (mode $expected_mode)"
  fi
  LAST_SHA="$sha"
}

run_state_writer() {
  local home="$1" session_id="$2" out="$3" err="$4"
  ( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
    'import sys
from hermes_state import SessionDB
db = SessionDB()
db.create_session(session_id=sys.argv[1], source="cli")
db.close()
print("SessionDB() + create_session() closed:", sys.argv[1])' "$session_id" ) >"$out" 2>"$err"
}

note "probe_conversion_persistence: scratch_root=$ROOT"
note "probe_conversion_persistence: hermes_src=$HERMES_SRC"
note "probe_conversion_persistence: python=$($PYTHON --version 2>&1)"
note "probe_conversion_persistence: hermes=$("$HERMES_BIN" --version 2>&1 | head -n 1)"
note "probe_conversion_persistence: real_home=$REAL_HOME (never opened by design)"
note "probe_conversion_persistence: header_reader=$READ_HEADER (raw bytes 18/19 only; no SQLite connection)"
note "probe_conversion_persistence: host_native=/proc/1/cgroup=$(tr '\n' ' ' < /proc/1/cgroup 2>/dev/null)"

# ── 1. Seed a real WAL state.db ─────────────────────────────────────────────
SEED_HOME="$ROOT/seed-wal/home"
mkdir -p "$SEED_HOME"
note ""
note "== 1. Seed a real state.db under database.journal_mode: wal =="
write_config "$SEED_HOME" wal
note "config_path: $SEED_HOME/config.yaml"
note "config_realpath: $(readlink -f -- "$SEED_HOME/config.yaml")"
confirm_resolved_mode "$SEED_HOME" wal
note "writer: SessionDB() + create_session(session_id='g1-conversion-seed')"
run_state_writer "$SEED_HOME" "g1-conversion-seed" "$ROOT/seed-writer.out" "$ROOT/seed-writer.err"
SEED_RC=$?
note "writer_exit: $SEED_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/seed-writer.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/seed-writer.err")"
if [ "$SEED_RC" -ne 0 ]; then
  fail "seed writer failed (exit $SEED_RC)"
fi
measure_assert "seed_wal_state_db" "$SEED_HOME/state.db" "2 2" "wal" || true
ORIGINAL_SHA="$(sha256_of "$SEED_HOME/state.db")"
note "original_sha256: $ORIGINAL_SHA"
note "original_size: $(stat -c '%s' "$SEED_HOME/state.db")"

# ── 2. Copy with cp -a and prove byte identity before conversion ────────────
CONVERSION_DIR="$ROOT/conversion"
mkdir -p "$CONVERSION_DIR"
CONV_DB="$CONVERSION_DIR/state.db"
note ""
note "== 2. Copy the WAL store with cp -a and prove the copy is byte-identical =="
note "command: cp -a -- $SEED_HOME/state.db $CONV_DB"
cp -a -- "$SEED_HOME/state.db" "$CONV_DB"
COPY_SHA_BEFORE="$(sha256_of "$CONV_DB")"
note "copy_sha256: $COPY_SHA_BEFORE"
measure_assert "conversion_copy_before" "$CONV_DB" "2 2" "wal" || true
if [ "$COPY_SHA_BEFORE" = "$ORIGINAL_SHA" ] && cmp -s -- "$SEED_HOME/state.db" "$CONV_DB"; then
  pass "copy equals original before conversion (sha256 $COPY_SHA_BEFORE)"
else
  fail "copy does not equal original before conversion (original $ORIGINAL_SHA, copy $COPY_SHA_BEFORE)"
fi

# ── 3. Offline conversion on the copy with the supported command ────────────
note ""
note "== 3. Convert the COPY offline with 'hermes sessions set-journal-mode delete' =="
note "command: HERMES_HOME=$SEED_HOME $WRAPPER sessions set-journal-mode delete --db $CONV_DB"
HERMES_HOME="$SEED_HOME" "$WRAPPER" sessions set-journal-mode delete --db "$CONV_DB" \
  >"$CONVERSION_DIR/convert.stdout" 2>"$CONVERSION_DIR/convert.stderr"
CONVERT_RC=$?
note "conversion_exit: $CONVERT_RC"
note "conversion_stdout:"
sed 's/^/  /' "$CONVERSION_DIR/convert.stdout"
note "conversion_stderr:"
sed 's/^/  /' "$CONVERSION_DIR/convert.stderr"
if [ "$CONVERT_RC" -ne 0 ]; then
  fail "offline conversion command failed (exit $CONVERT_RC)"
fi
measure_assert "converted_copy" "$CONV_DB" "1 1" "delete" || true

ORIGINAL_SHA_AFTER="$(sha256_of "$SEED_HOME/state.db")"
note "original_sha256_before_conversion: $ORIGINAL_SHA"
note "original_sha256_after_conversion:  $ORIGINAL_SHA_AFTER"
if [ "$ORIGINAL_SHA_AFTER" = "$ORIGINAL_SHA" ]; then
  pass "original WAL store sha256 is unchanged by conversion of the copy"
else
  fail "original WAL store changed during conversion (before $ORIGINAL_SHA, after $ORIGINAL_SHA_AFTER)"
fi
CONVERTED_COPY_SHA="$(sha256_of "$CONV_DB")"
note "converted_copy_sha256: $CONVERTED_COPY_SHA"

# ── 4. Next writer TWICE under database.journal_mode: delete ────────────────
DELETE_HOME="$ROOT/delete/home"
mkdir -p "$DELETE_HOME"
note ""
note "== 4. Writer TWICE against the converted copy under database.journal_mode: delete =="
write_config "$DELETE_HOME" delete
note "config_path: $DELETE_HOME/config.yaml"
note "config_realpath: $(readlink -f -- "$DELETE_HOME/config.yaml")"
note "command: cp -a -- $CONV_DB $DELETE_HOME/state.db"
cp -a -- "$CONV_DB" "$DELETE_HOME/state.db"
confirm_resolved_mode "$DELETE_HOME" delete
for run in 1 2; do
  note ""
  note "writer_run: $run (database.journal_mode=delete)"
  run_state_writer "$DELETE_HOME" "g1-conversion-delete-$run" \
    "$ROOT/delete-writer-$run.out" "$ROOT/delete-writer-$run.err"
  WRITER_RC=$?
  note "writer_exit: $WRITER_RC"
  note "writer_stdout: $(tr '\n' '|' < "$ROOT/delete-writer-$run.out")"
  note "writer_stderr: $(tr '\n' '|' < "$ROOT/delete-writer-$run.err")"
  if [ "$WRITER_RC" -ne 0 ]; then
    fail "delete-home writer run $run failed (exit $WRITER_RC)"
  fi
  measure_assert "delete_run_${run}" "$DELETE_HOME/state.db" "1 1" "delete" || true
  printf '%s\n' "$LAST_SHA" > "$ROOT/delete-run-$run.sha"
done
note ""
note "delete_home_sha256_after_run1: $(cat "$ROOT/delete-run-1.sha" 2>/dev/null || echo unknown)"
note "delete_home_sha256_after_run2: $(cat "$ROOT/delete-run-2.sha" 2>/dev/null || echo unknown)"

# ── 5. WAL control: same converted copy, configured wal, one writer ─────────
CONTROL_HOME="$ROOT/wal-control/home"
mkdir -p "$CONTROL_HOME"
note ""
note "== 5. Control: SAME converted copy under database.journal_mode: wal, writer ONCE =="
note "purpose: prove the CONFIGURED value, not the conversion, decides the next open"
write_config "$CONTROL_HOME" wal
note "config_path: $CONTROL_HOME/config.yaml"
note "config_realpath: $(readlink -f -- "$CONTROL_HOME/config.yaml")"
note "command: cp -a -- $CONV_DB $CONTROL_HOME/state.db"
cp -a -- "$CONV_DB" "$CONTROL_HOME/state.db"
confirm_resolved_mode "$CONTROL_HOME" wal
note "writer_run: control (database.journal_mode=wal)"
run_state_writer "$CONTROL_HOME" "g1-conversion-wal-control" \
  "$ROOT/control-writer.out" "$ROOT/control-writer.err"
CONTROL_RC=$?
note "writer_exit: $CONTROL_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/control-writer.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/control-writer.err")"
if [ "$CONTROL_RC" -ne 0 ]; then
  fail "wal-control writer failed (exit $CONTROL_RC)"
fi
measure_assert "wal_control_run" "$CONTROL_HOME/state.db" "2 2" "wal" || true
CONTROL_SHA="$(sha256_of "$CONTROL_HOME/state.db")"
note "wal_control_sha256: $CONTROL_SHA"
note "CONTROL: the converted 1,1 copy became 2,2 again because database.journal_mode=wal was"
note "CONTROL: configured for this home. The WAL control is config-driven, not a delete-mode failure."

# ── 6. Conversion source stayed rollback and untouched ──────────────────────
note ""
note "== 6. Conversion source integrity =="
FINAL_CONVERTED_SHA="$(sha256_of "$CONV_DB")"
note "converted_copy_sha256_before_writers: $CONVERTED_COPY_SHA"
note "converted_copy_sha256_after_writers:  $FINAL_CONVERTED_SHA"
if [ "$FINAL_CONVERTED_SHA" = "$CONVERTED_COPY_SHA" ]; then
  pass "conversion source copy was untouched by both writer homes (sha256 $FINAL_CONVERTED_SHA)"
else
  fail "conversion source copy changed (before $CONVERTED_COPY_SHA, after $FINAL_CONVERTED_SHA)"
fi
FINAL_ORIGINAL_SHA="$(sha256_of "$SEED_HOME/state.db")"
note "original_wal_sha256_final: $FINAL_ORIGINAL_SHA"
if [ "$FINAL_ORIGINAL_SHA" = "$ORIGINAL_SHA" ]; then
  pass "original WAL store sha256 is still unchanged at the end"
else
  fail "original WAL store changed at the end (expected $ORIGINAL_SHA, got $FINAL_ORIGINAL_SHA)"
fi

# ── 7. Verdict ──────────────────────────────────────────────────────────────
note ""
note "== state.db offline-conversion persistence verdict =="
printf '%-30s %-10s %-10s %-12s %s\n' "stage" "bytes" "mode" "writer_runs" "result"
if [ "$FAILURES" -eq 0 ]; then
  printf '%-30s %-10s %-10s %-12s %s\n' "seed WAL" "2,2" "wal" "1 (create)" "control baseline"
  printf '%-30s %-10s %-10s %-12s %s\n' "converted copy" "1,1" "delete" "offline" "converted"
  printf '%-30s %-10s %-10s %-12s %s\n' "delete home after run 1" "1,1" "delete" "2" "kept rollback"
  printf '%-30s %-10s %-10s %-12s %s\n' "delete home after run 2" "1,1" "delete" "2" "kept rollback"
  printf '%-30s %-10s %-10s %-12s %s\n' "wal control after run" "2,2" "wal" "1" "config-driven"
  note ""
  note "STATE.DB VERDICT: HONOURING"
  note "state.db was created WAL (2,2), converted offline on a copy to rollback (1,1),"
  note "stayed 1,1 across two consecutive writer runs under database.journal_mode=delete,"
  note "and returned to 2,2 only in the database.journal_mode=wal control."
else
  note ""
  note "STATE.DB VERDICT: NOT-HONOURING / UNKNOWN ($FAILURES failed assertion(s))"
fi

note ""
note "native_execution: /proc/1/cgroup=$(cat /proc/1/cgroup 2>/dev/null | tr '\n' ' ')"
if [ "$FAILURES" -ne 0 ]; then
  note "RESULT: FAIL ($FAILURES assertion(s) failed)"
  exit 1
fi
note "RESULT: PASS (state.db conversion persists across two delete-mode writer runs; WAL control flips to 2,2)"
if [ "$KEEP" = "0" ]; then
  note "scratch root removed on exit"
else
  note "scratch root kept: $ROOT"
fi
exit 0
