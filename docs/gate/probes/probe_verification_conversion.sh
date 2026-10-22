#!/bin/bash
# probe_verification_conversion.sh — establish the optionality boundary of
# verification_evidence.db and prove whether its offline conversion to rollback
# journal survives the next real writer.
#
# The store is feature-gated: it only exists to feed verify-on-stop.  This probe
# first proves that gate from behaviour (off -> no store and record_verify_run()
# returns None; on -> store created and an event row recorded), then repeats the
# US-005 offline-conversion experiment for this store:
#
#   1. optionality/off/home     no agent.verify_on_stop, no HERMES_VERIFY_ON_STOP
#                               verify_on_stop_enabled() == False
#                               record_verify_run() returns None
#                               verification_evidence.db absent
#   2. optionality/on/home      agent.verify_on_stop: true
#                               record_verify_run() returns an event id
#                               verification_evidence.db exists, header 2,2
#   3. seed-wal/home            database.journal_mode: wal + verify-on-stop on
#                               record_verify_run() -> WAL store, header 2,2
#                               record sha256 of the original (ORIGINAL_SHA)
#   4. conversion/verification_evidence.db
#                               cp -a of the original; sha256 + cmp prove the
#                               copy is byte-identical before conversion
#   5. conversion               `hermes sessions set-journal-mode delete --db
#                               <copy>` -> header 1,1; re-hash the original and
#                               prove ORIGINAL_SHA unchanged
#   6. delete/home              database.journal_mode: delete + verify-on-stop on
#                               converted copy placed as the live store; run the
#                               real writer TWICE, read the header after each
#                               close.  Both must be 1,1, else this is a
#                               COMPATIBILITY BLOCKER.
#   7. read-path/home           the read-only paths verification_status() and a
#                               direct _connect() read; record the header after
#                               each so a read that silently flips the store is
#                               caught.
#   8. wal-control/home         database.journal_mode: wal + verify-on-stop on;
#                               the SAME converted copy, one writer -> 2,2.  The
#                               control proves the configured value decides the
#                               next open, not that the file resists conversion.
#
# Journal format is read ONLY with read_header.py (raw bytes 18/19).  No SQLite
# connection is opened by this probe to inspect a journal mode: a connection can
# checkpoint a WAL and change the thing being measured.
#
# Usage:
#   ./probe_verification_conversion.sh
#
# Environment:
#   HERMES_SRC                    installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_VERIFICATION_ROOT          reuse a caller-created /tmp/g1-* root instead of mktemp
#   G1_KEEP_SCRATCH               set to 1 to keep a self-created root for inspection
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
    printf 'probe_verification_conversion: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

if [ -n "${G1_VERIFICATION_ROOT:-}" ]; then
  ROOT="$G1_VERIFICATION_ROOT"
  mkdir -p "$ROOT"
  KEEP=1
else
  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-verification.XXXXXX")" || exit 2
  if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
    KEEP=1
  else
    KEEP=0
    trap 'rm -rf -- "$ROOT"' EXIT
  fi
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'probe_verification_conversion: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
    exit 64
    ;;
esac

# A scratch HOME removes the last Path.home() fallback path to ~/.hermes.
OPERATOR_HOME="$ROOT/operator-home"
mkdir -p "$OPERATOR_HOME"
export HOME="$OPERATOR_HOME"

# Never inherit a store-routing or verify-on-stop override from the invoking
# daemon.  HERMES_JOURNAL_MODE is not a config layer (US-002), but unset it
# anyway so the probe can never be steered by the environment.
unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_VERIFY_ON_STOP HERMES_JOURNAL_MODE

FAILURES=0

note() { printf '%s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); printf 'ASSERT FAIL: %s\n' "$*"; }
pass() { printf 'ASSERT PASS: %s\n' "$*"; }

# write_config <home> <journal_mode> <verify_on_stop: on|off|absent>
write_config() {
  local home="$1" mode="$2" verify="$3"
  mkdir -p "$home"
  {
    printf 'database:\n  journal_mode: %s\n' "$mode"
    case "$verify" in
      on)     printf 'agent:\n  verify_on_stop: true\n' ;;
      off)    printf 'agent:\n  verify_on_stop: false\n' ;;
      absent) : ;;
      *)      printf 'probe: bad verify argument %s\n' "$verify" >&2; return 2 ;;
    esac
  } > "$home/config.yaml"
}

# Confirm the home resolves to the intended journal mode before a writer runs.
confirm_resolved_mode() {
  local label="$1" home="$2" expected="$3" actual
  actual="$( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
    'from hermes_state_wal import resolve_journal_mode; print(resolve_journal_mode())' 2>/dev/null )"
  if [ "$actual" = "$expected" ]; then
    pass "$label resolves database.journal_mode=$expected before the writer"
  else
    fail "$label resolved '$actual', expected '$expected' before the writer"
  fi
}

# Confirm verify_on_stop_enabled() from the real config layer.
confirm_verify_enabled() {
  local label="$1" home="$2" expected="$3" env_value="$4" actual
  if [ "$env_value" = "unset" ]; then
    actual="$( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
      'from agent.verification_stop import verify_on_stop_enabled; print("true" if verify_on_stop_enabled() else "false")' 2>/dev/null )"
  else
    actual="$( cd "$HERMES_SRC" && HERMES_HOME="$home" HERMES_VERIFY_ON_STOP="$env_value" "$PYTHON" -c \
      'from agent.verification_stop import verify_on_stop_enabled; print("true" if verify_on_stop_enabled() else "false")' 2>/dev/null )"
  fi
  if [ "$actual" = "$expected" ]; then
    pass "$label verify_on_stop_enabled()=$expected"
  else
    fail "$label verify_on_stop_enabled()='$actual', expected '$expected'"
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
    printf 'MISSING MISSING MISSING missing\n' > "$ROOT/.measure-result"
    return 1
  fi
  header_json="$("$PYTHON" "$READ_HEADER" "$db" 2>/dev/null)" || {
    fail "$label: read_header.py failed on $db"
    printf 'ERROR ERROR ERROR unknown\n' > "$ROOT/.measure-result"
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
  LAST_PAIR="$byte18,$byte19"
  LAST_MODE="$mode"
}

# Run record_verify_run() through the real writer.  Prints the returned event id
# (or 'None'); exits nonzero only when the Python process itself fails.
run_verify_writer() {
  local home="$1" session_id="$2" out="$3" err="$4"
  ( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
    'import sys
from agent.verification_evidence import record_verify_run
result = record_verify_run(root=sys.argv[1], session_id=sys.argv[2], ok=True)
print("record_verify_run_return:", repr(result))
if result is None:
    print("event_id: None")
else:
    print("event_id:", result.get("id"))' "$ROOT/workspace" "$session_id" ) >"$out" 2>"$err"
}

event_id_of() {
  sed -n 's/^event_id: //p' "$1" | tail -n 1
}

note "probe_verification_conversion: scratch_root=$ROOT"
note "probe_verification_conversion: hermes_src=$HERMES_SRC"
note "probe_verification_conversion: python=$($PYTHON --version 2>&1)"
note "probe_verification_conversion: hermes=$("$HERMES_BIN" --version 2>&1 | head -n 1)"
note "probe_verification_conversion: real_home=$REAL_HOME (never opened by design)"
note "probe_verification_conversion: header_reader=$READ_HEADER (raw bytes 18/19 only; no SQLite connection)"
note "probe_verification_conversion: host_native=/proc/1/cgroup=$(tr '\n' ' ' < /proc/1/cgroup 2>/dev/null)"
note "probe_verification_conversion: verify_on_stop precedence (agent/verification_stop.py):"
note "  HERMES_VERIFY_ON_STOP env (if set) -> agent.verify_on_stop config -> default OFF; 'auto' is surface-aware"

# The read-path probe needs a workspace that project_facts_for() recognises.
# A package.json marker makes this a workspace without touching any repo.
WORKSPACE="$ROOT/workspace"
mkdir -p "$WORKSPACE"
printf '{"name":"g1-verification-workspace","private":true}\n' > "$WORKSPACE/package.json"

# ── 1. Optionality boundary: verify-on-stop OFF ─────────────────────────────
OFF_HOME="$ROOT/optionality/off/home"
mkdir -p "$OFF_HOME"
note ""
note "== 1. verify-on-stop OFF: optionality boundary =="
write_config "$OFF_HOME" wal absent
note "config_path: $OFF_HOME/config.yaml"
note "config_contents: $(tr '\n' '|' < "$OFF_HOME/config.yaml")"
confirm_resolved_mode "optionality-off" "$OFF_HOME" wal
confirm_verify_enabled "optionality-off (no env)" "$OFF_HOME" false unset
confirm_verify_enabled "optionality-off + HERMES_VERIFY_ON_STOP=1" "$OFF_HOME" true 1
run_verify_writer "$OFF_HOME" "g1-verification-optionality-off" \
  "$ROOT/optionality-off.out" "$ROOT/optionality-off.err"
OFF_RC=$?
note "writer_exit: $OFF_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/optionality-off.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/optionality-off.err")"
if [ "$OFF_RC" -ne 0 ]; then
  fail "optionality-off writer failed (exit $OFF_RC)"
fi
OFF_EVENT="$(event_id_of "$ROOT/optionality-off.out")"
if [ "$OFF_EVENT" = "None" ]; then
  pass "record_verify_run() returned None with verify-on-stop off"
else
  fail "record_verify_run() returned '$OFF_EVENT' with verify-on-stop off, expected None"
fi
if [ ! -e "$OFF_HOME/verification_evidence.db" ]; then
  pass "verification_evidence.db is absent when verify-on-stop is off"
else
  fail "verification_evidence.db was created even though verify-on-stop is off"
fi

# ── 2. Optionality boundary: verify-on-stop ON via config ───────────────────
ON_HOME="$ROOT/optionality/on/home"
mkdir -p "$ON_HOME"
note ""
note "== 2. verify-on-stop ON via agent.verify_on_stop: true =="
write_config "$ON_HOME" wal on
note "config_path: $ON_HOME/config.yaml"
note "config_contents: $(tr '\n' '|' < "$ON_HOME/config.yaml")"
confirm_resolved_mode "optionality-on" "$ON_HOME" wal
confirm_verify_enabled "optionality-on (config true)" "$ON_HOME" true unset
confirm_verify_enabled "optionality-on + HERMES_VERIFY_ON_STOP=0" "$ON_HOME" false 0
run_verify_writer "$ON_HOME" "g1-verification-optionality-on" \
  "$ROOT/optionality-on.out" "$ROOT/optionality-on.err"
ON_RC=$?
note "writer_exit: $ON_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/optionality-on.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/optionality-on.err")"
if [ "$ON_RC" -ne 0 ]; then
  fail "optionality-on writer failed (exit $ON_RC)"
fi
ON_EVENT="$(event_id_of "$ROOT/optionality-on.out")"
if [ "$ON_EVENT" != "None" ] && [ -n "$ON_EVENT" ]; then
  pass "record_verify_run() recorded an event (id $ON_EVENT) with verify-on-stop on"
else
  fail "record_verify_run() returned '$ON_EVENT' with verify-on-stop on, expected an event id"
fi
measure_assert "optionality_on_store" "$ON_HOME/verification_evidence.db" "2 2" "wal" || true

# ── 3. Seed a real WAL verification_evidence.db ─────────────────────────────
SEED_HOME="$ROOT/seed-wal/home"
mkdir -p "$SEED_HOME"
note ""
note "== 3. Seed a real verification_evidence.db under database.journal_mode: wal =="
write_config "$SEED_HOME" wal on
note "config_path: $SEED_HOME/config.yaml"
note "config_realpath: $(readlink -f -- "$SEED_HOME/config.yaml")"
note "config_contents: $(tr '\n' '|' < "$SEED_HOME/config.yaml")"
confirm_resolved_mode "seed-wal" "$SEED_HOME" wal
confirm_verify_enabled "seed-wal" "$SEED_HOME" true unset
note "writer: record_verify_run(session_id='g1-verification-seed', ok=True)"
run_verify_writer "$SEED_HOME" "g1-verification-seed" \
  "$ROOT/seed-writer.out" "$ROOT/seed-writer.err"
SEED_RC=$?
note "writer_exit: $SEED_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/seed-writer.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/seed-writer.err")"
if [ "$SEED_RC" -ne 0 ]; then
  fail "seed writer failed (exit $SEED_RC)"
fi
SEED_EVENT="$(event_id_of "$ROOT/seed-writer.out")"
note "seed_event_id: $SEED_EVENT"
measure_assert "seed_wal_verification_evidence_db" "$SEED_HOME/verification_evidence.db" "2 2" "wal" || true
ORIGINAL_SHA="$(sha256_of "$SEED_HOME/verification_evidence.db")"
note "original_sha256: $ORIGINAL_SHA"
note "original_size: $(stat -c '%s' "$SEED_HOME/verification_evidence.db")"

# ── 4. Copy with cp -a and prove byte identity before conversion ────────────
CONVERSION_DIR="$ROOT/conversion"
mkdir -p "$CONVERSION_DIR"
CONV_DB="$CONVERSION_DIR/verification_evidence.db"
note ""
note "== 4. Copy the WAL store with cp -a and prove the copy is byte-identical =="
note "command: cp -a -- $SEED_HOME/verification_evidence.db $CONV_DB"
cp -a -- "$SEED_HOME/verification_evidence.db" "$CONV_DB"
COPY_SHA_BEFORE="$(sha256_of "$CONV_DB")"
note "copy_sha256: $COPY_SHA_BEFORE"
measure_assert "conversion_copy_before" "$CONV_DB" "2 2" "wal" || true
if [ "$COPY_SHA_BEFORE" = "$ORIGINAL_SHA" ] && cmp -s -- "$SEED_HOME/verification_evidence.db" "$CONV_DB"; then
  pass "copy equals original before conversion (sha256 $COPY_SHA_BEFORE)"
else
  fail "copy does not equal original before conversion (original $ORIGINAL_SHA, copy $COPY_SHA_BEFORE)"
fi

# ── 5. Offline conversion on the copy with the supported command ────────────
note ""
note "== 5. Convert the COPY offline with 'hermes sessions set-journal-mode delete' =="
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

ORIGINAL_SHA_AFTER="$(sha256_of "$SEED_HOME/verification_evidence.db")"
note "original_sha256_before_conversion: $ORIGINAL_SHA"
note "original_sha256_after_conversion:  $ORIGINAL_SHA_AFTER"
if [ "$ORIGINAL_SHA_AFTER" = "$ORIGINAL_SHA" ]; then
  pass "original WAL store sha256 is unchanged by conversion of the copy"
else
  fail "original WAL store changed during conversion (before $ORIGINAL_SHA, after $ORIGINAL_SHA_AFTER)"
fi
CONVERTED_COPY_SHA="$(sha256_of "$CONV_DB")"
note "converted_copy_sha256: $CONVERTED_COPY_SHA"

# ── 6. Next writer TWICE under database.journal_mode: delete ────────────────
DELETE_HOME="$ROOT/delete/home"
mkdir -p "$DELETE_HOME"
note ""
note "== 6. Writer TWICE against the converted copy under database.journal_mode: delete =="
write_config "$DELETE_HOME" delete on
note "config_path: $DELETE_HOME/config.yaml"
note "config_realpath: $(readlink -f -- "$DELETE_HOME/config.yaml")"
note "config_contents: $(tr '\n' '|' < "$DELETE_HOME/config.yaml")"
note "command: cp -a -- $CONV_DB $DELETE_HOME/verification_evidence.db"
cp -a -- "$CONV_DB" "$DELETE_HOME/verification_evidence.db"
confirm_resolved_mode "delete-home" "$DELETE_HOME" delete
confirm_verify_enabled "delete-home" "$DELETE_HOME" true unset
DELETE_PAIRS=()
for run in 1 2; do
  note ""
  note "writer_run: $run (database.journal_mode=delete, verify-on-stop on)"
  run_verify_writer "$DELETE_HOME" "g1-verification-delete-$run" \
    "$ROOT/delete-writer-$run.out" "$ROOT/delete-writer-$run.err"
  WRITER_RC=$?
  note "writer_exit: $WRITER_RC"
  note "writer_stdout: $(tr '\n' '|' < "$ROOT/delete-writer-$run.out")"
  note "writer_stderr: $(tr '\n' '|' < "$ROOT/delete-writer-$run.err")"
  if [ "$WRITER_RC" -ne 0 ]; then
    fail "delete-home writer run $run failed (exit $WRITER_RC)"
  fi
  DELETE_EVENT="$(event_id_of "$ROOT/delete-writer-$run.out")"
  note "delete_run_${run}_event_id: $DELETE_EVENT"
  if [ "$DELETE_EVENT" = "None" ] || [ -z "$DELETE_EVENT" ]; then
    fail "delete-home writer run $run recorded no event"
  fi
  measure_assert "delete_run_${run}" "$DELETE_HOME/verification_evidence.db" "1 1" "delete" || true
  DELETE_PAIRS+=("$LAST_PAIR")
  printf '%s\n' "$LAST_SHA" > "$ROOT/delete-run-$run.sha"
done
note ""
note "delete_home_sha256_after_run1: $(cat "$ROOT/delete-run-1.sha" 2>/dev/null || echo unknown)"
note "delete_home_sha256_after_run2: $(cat "$ROOT/delete-run-2.sha" 2>/dev/null || echo unknown)"

# ── 7. Read-only paths: verification_status() and a direct _connect() read ──
READ_HOME="$ROOT/read-path/home"
mkdir -p "$READ_HOME"
note ""
note "== 7. Read-only paths against a converted copy under database.journal_mode: delete =="
write_config "$READ_HOME" delete on
note "config_path: $READ_HOME/config.yaml"
note "command: cp -a -- $CONV_DB $READ_HOME/verification_evidence.db"
cp -a -- "$CONV_DB" "$READ_HOME/verification_evidence.db"
confirm_resolved_mode "read-path-home" "$READ_HOME" delete
confirm_verify_enabled "read-path-home" "$READ_HOME" true unset
measure_assert "read_path_before_reads" "$READ_HOME/verification_evidence.db" "1 1" "delete" || true
# The converted copy still carries the seed event/state, so reading the seed
# session proves the read resolves recorded evidence, not just that a connection
# opened against an empty ledger.
( cd "$HERMES_SRC" && HERMES_HOME="$READ_HOME" "$PYTHON" -c \
  'import json, sys
from agent.verification_evidence import verification_status
status = verification_status(session_id=sys.argv[1], cwd=sys.argv[2])
print("verification_status:", json.dumps(status, default=str, sort_keys=True))' \
  "g1-verification-seed" "$WORKSPACE" ) >"$ROOT/read-status.out" 2>"$ROOT/read-status.err"
STATUS_RC=$?
note "verification_status_exit: $STATUS_RC"
note "verification_status_stdout: $(tr '\n' '|' < "$ROOT/read-status.out")"
note "verification_status_stderr: $(tr '\n' '|' < "$ROOT/read-status.err")"
if [ "$STATUS_RC" -ne 0 ]; then
  fail "verification_status() read failed (exit $STATUS_RC)"
fi
if grep -q '"status": "passed"' "$ROOT/read-status.out"; then
  pass "verification_status() resolved the recorded seed event as passed"
else
  fail "verification_status() did not resolve the recorded seed event as passed"
fi
measure_assert "read_path_after_verification_status" "$READ_HOME/verification_evidence.db" "1 1" "delete" || true

( cd "$HERMES_SRC" && HERMES_HOME="$READ_HOME" "$PYTHON" -c \
  'from agent.verification_evidence import _connect
conn = _connect()
try:
    row = conn.execute("SELECT COUNT(*) AS n FROM verification_events").fetchone()
    print("connect_read_event_count:", int(row["n"]))
finally:
    conn.close()' ) >"$ROOT/read-connect.out" 2>"$ROOT/read-connect.err"
CONNECT_RC=$?
note "connect_read_exit: $CONNECT_RC"
note "connect_read_stdout: $(tr '\n' '|' < "$ROOT/read-connect.out")"
note "connect_read_stderr: $(tr '\n' '|' < "$ROOT/read-connect.err")"
if [ "$CONNECT_RC" -ne 0 ]; then
  fail "_connect() read failed (exit $CONNECT_RC)"
fi
measure_assert "read_path_after_connect" "$READ_HOME/verification_evidence.db" "1 1" "delete" || true
printf '%s\n' "$LAST_SHA" > "$ROOT/read-path.sha"
note "read_path_sha256: $(cat "$ROOT/read-path.sha")"

# ── 8. WAL control: same converted copy, configured wal, one writer ─────────
CONTROL_HOME="$ROOT/wal-control/home"
mkdir -p "$CONTROL_HOME"
note ""
note "== 8. Control: SAME converted copy under database.journal_mode: wal, writer ONCE =="
note "purpose: prove the CONFIGURED value, not the conversion, decides the next open"
write_config "$CONTROL_HOME" wal on
note "config_path: $CONTROL_HOME/config.yaml"
note "command: cp -a -- $CONV_DB $CONTROL_HOME/verification_evidence.db"
cp -a -- "$CONV_DB" "$CONTROL_HOME/verification_evidence.db"
confirm_resolved_mode "wal-control-home" "$CONTROL_HOME" wal
confirm_verify_enabled "wal-control-home" "$CONTROL_HOME" true unset
note "writer_run: control (database.journal_mode=wal)"
run_verify_writer "$CONTROL_HOME" "g1-verification-wal-control" \
  "$ROOT/control-writer.out" "$ROOT/control-writer.err"
CONTROL_RC=$?
note "writer_exit: $CONTROL_RC"
note "writer_stdout: $(tr '\n' '|' < "$ROOT/control-writer.out")"
note "writer_stderr: $(tr '\n' '|' < "$ROOT/control-writer.err")"
if [ "$CONTROL_RC" -ne 0 ]; then
  fail "wal-control writer failed (exit $CONTROL_RC)"
fi
measure_assert "wal_control_run" "$CONTROL_HOME/verification_evidence.db" "2 2" "wal" || true
CONTROL_SHA="$(sha256_of "$CONTROL_HOME/verification_evidence.db")"
note "wal_control_sha256: $CONTROL_SHA"
note "CONTROL: the converted 1,1 copy became 2,2 again because database.journal_mode=wal was"
note "CONTROL: configured for this home. The WAL control is config-driven, not a delete-mode failure."

# ── 9. Conversion source / originals stayed untouched ───────────────────────
note ""
note "== 9. Conversion source and original integrity =="
FINAL_CONVERTED_SHA="$(sha256_of "$CONV_DB")"
note "converted_copy_sha256_before_writers: $CONVERTED_COPY_SHA"
note "converted_copy_sha256_after_writers:  $FINAL_CONVERTED_SHA"
if [ "$FINAL_CONVERTED_SHA" = "$CONVERTED_COPY_SHA" ]; then
  pass "conversion source copy was untouched by the delete/read/control homes (sha256 $FINAL_CONVERTED_SHA)"
else
  fail "conversion source copy changed (before $CONVERTED_COPY_SHA, after $FINAL_CONVERTED_SHA)"
fi
FINAL_ORIGINAL_SHA="$(sha256_of "$SEED_HOME/verification_evidence.db")"
note "original_wal_sha256_final: $FINAL_ORIGINAL_SHA"
if [ "$FINAL_ORIGINAL_SHA" = "$ORIGINAL_SHA" ]; then
  pass "original WAL store sha256 is still unchanged at the end"
else
  fail "original WAL store changed at the end (expected $ORIGINAL_SHA, got $FINAL_ORIGINAL_SHA)"
fi

# ── 10. Verdict ─────────────────────────────────────────────────────────────
note ""
note "== verification_evidence.db optionality + conversion-persistence verdict =="
printf '%-34s %-9s %-8s %-13s %s\n' "stage" "header" "mode" "writer_runs" "result"
printf '%-34s %-9s %-8s %-13s %s\n' "verify OFF" "absent" "-" "0" "optional store not created"
printf '%-34s %-9s %-8s %-13s %s\n' "verify ON (config)" "2,2" "wal" "1 (create)" "optional store created"
printf '%-34s %-9s %-8s %-13s %s\n' "seed WAL" "2,2" "wal" "1 (create)" "control baseline"
printf '%-34s %-9s %-8s %-13s %s\n' "converted copy" "1,1" "delete" "offline" "converted"
for idx in 1 2; do
  printf '%-34s %-9s %-8s %-13s %s\n' "delete home after run $idx" "${DELETE_PAIRS[$((idx - 1))]:-?}" "delete" "$idx" "next-writer result"
done
printf '%-34s %-9s %-8s %-13s %s\n' "read path (status + connect)" "1,1" "delete" "0" "reads did not flip"
printf '%-34s %-9s %-8s %-13s %s\n' "wal control after run" "2,2" "wal" "1" "config-driven"
note ""
if [ "$FAILURES" -eq 0 ]; then
  note "VERIFICATION_EVIDENCE.DB VERDICT: HONOURING"
  note "verification_evidence.db is OPTIONAL: verify-on-stop gates its existence (off -> absent,"
  note "record_verify_run() -> None; on -> created with a recorded event)."
  note "It was created WAL (2,2), converted offline on a copy to rollback (1,1), stayed 1,1 across"
  note "two consecutive real writer runs under database.journal_mode=delete, and stayed 1,1 across"
  note "verification_status() and a direct _connect() read. The WAL control flipped the same"
  note "converted copy to 2,2, so the configured value decides the next open."
else
  note "VERIFICATION_EVIDENCE.DB VERDICT: NOT-HONOURING / COMPATIBILITY BLOCKER ($FAILURES failed assertion(s))"
  note "The converted store did not stay rollback-journal under database.journal_mode=delete."
  note "This store therefore cannot be made to comply by configuration plus offline conversion;"
  note "report it as a compatibility blocker, do not quietly exclude it, and do not modify hermes'"
  note "database subsystem."
fi

note ""
note "native_execution: /proc/1/cgroup=$(cat /proc/1/cgroup 2>/dev/null | tr '\n' ' ')"
if [ "$FAILURES" -ne 0 ]; then
  note "RESULT: FAIL ($FAILURES assertion(s) failed)"
  exit 1
fi
note "RESULT: PASS (verification_evidence.db conversion persists across two delete-mode writer runs; reads do not flip it)"
if [ "$KEEP" = "0" ]; then
  note "scratch root removed on exit"
else
  note "scratch root kept: $ROOT"
fi
exit 0
