#!/bin/bash
# probe_optional_conversion.sh — close the US-007 gap for the two remaining
# optional stores: prove whether an existing WAL kanban.db / projects.db,
# converted OFFLINE on a copy to rollback journal, stays rollback after the
# next real writer open under database.journal_mode: delete.
#
# US-004 measured fresh creation for all four stores and US-005/US-006 measured
# offline-conversion persistence for state.db and verification_evidence.db.
# This probe applies the same measurement to the other two so the final
# per-store verdict table has no unexplained UNKNOWN.
#
# Flow per store (every directory is under a mktemp-created /tmp/g1-* root):
#
#   1. seed-wal/home       database.journal_mode: wal
#                          real trigger creates the store -> header 2,2
#                          record sha256 of the original (ORIGINAL_SHA)
#   2. conversion/<store>  cp -a of the original; sha256 + cmp prove it is a
#                          byte-identical copy before conversion
#   3. conversion          `hermes sessions set-journal-mode delete --db
#                          <copy>` (the supported offline path) -> header 1,1;
#                          re-hash the original and prove ORIGINAL_SHA unchanged
#   4. delete/home         database.journal_mode: delete; place the converted
#                          copy as the store; run the real trigger TWICE; read
#                          the header after each close.  Both must be 1,1.
#   5. wal-control/home    database.journal_mode: wal; place the SAME converted
#                          copy; run the trigger ONCE; the header returns to
#                          2,2.  This proves the configured mode, not the
#                          conversion, decides the next open.
#
# Journal format is read ONLY with read_header.py (raw bytes 18/19).  No SQLite
# connection is opened to inspect a journal mode: a connection/checkpoint can
# change the thing being measured.
#
# Usage:
#   ./probe_optional_conversion.sh
#
# Environment:
#   HERMES_SRC          installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_OPTIONAL_ROOT    reuse a caller-created /tmp/g1-* root instead of mktemp
#   G1_KEEP_SCRATCH     set to 1 to keep a self-created root for inspection
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
    printf 'probe_optional_conversion: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

if [ -n "${G1_OPTIONAL_ROOT:-}" ]; then
  ROOT="$G1_OPTIONAL_ROOT"
  mkdir -p "$ROOT"
  KEEP=1
else
  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-optional.XXXXXX")" || exit 2
  if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
    KEEP=1
  else
    KEEP=0
    trap 'rm -rf -- "$ROOT"' EXIT
  fi
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'probe_optional_conversion: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
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
export HERMES_BIN

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

# Read one file's header with read_header.py only and print every story field.
# Sets MEASURE_SHA, MEASURE_B18, MEASURE_B19, MEASURE_MODE for the caller.
measure() {
  local label="$1" db="$2" header_json size dir base sidecars
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
  MEASURE_SHA="$(json_field "$header_json" sha256)"
  MEASURE_B18="$(json_field "$header_json" byte18)"
  MEASURE_B19="$(json_field "$header_json" byte19)"
  MEASURE_MODE="$(json_field "$header_json" mode)"
  note "header_json: $header_json"
  note "${label}_path: $db"
  note "${label}_size: $size"
  note "${label}_sha256: $MEASURE_SHA"
  note "${label}_byte18: $MEASURE_B18"
  note "${label}_byte19: $MEASURE_B19"
  note "${label}_observed_mode: $MEASURE_MODE"
  note "${label}_journal_sidecars:"
  sidecars="$(find "$dir" -maxdepth 1 -type f \
    \( -name "$base-wal" -o -name "$base-shm" -o -name "$base-journal" \) \
    -printf '%f\t%s\n' 2>/dev/null | sort)"
  if [ -z "$sidecars" ]; then note "  (none)"; else printf '%s\n' "$sidecars" | sed 's/^/  /'; fi
  note "${label}_related_files (ls -la, store prefix only):"
  find "$dir" -maxdepth 1 -type f -name "$base*" -printf '%M\t%10s\t%f\n' 2>/dev/null \
    | sort | sed 's/^/  /'
}

measure_assert() {
  local label="$1" db="$2" expected_pair="$3" expected_mode="$4"
  measure "$label" "$db" || return 1
  if [ "$MEASURE_B18 $MEASURE_B19" = "$expected_pair" ] && [ "$MEASURE_MODE" = "$expected_mode" ]; then
    pass "$label header is $MEASURE_B18,$MEASURE_B19 (mode $MEASURE_MODE)"
  else
    fail "$label header is $MEASURE_B18,$MEASURE_B19 (mode $MEASURE_MODE), expected $expected_pair (mode $expected_mode)"
  fi
  LAST_SHA="$MEASURE_SHA"
}

store_trigger_note() {
  case "$1" in
    kanban.db) printf 'hermes kanban list\n' ;;
    projects.db) printf 'hermes project list\n' ;;
    *) return 1 ;;
  esac
}

run_store_writer() {
  # run_store_writer <store> <home> <stdout-file> <stderr-file>
  local store="$1" home="$2" out="$3" err="$4"
  local trigger_note
  trigger_note="$(store_trigger_note "$store")" || return 1
  note "trigger: $trigger_note"
  case "$store" in
    kanban.db)
      HERMES_HOME="$home" "$WRAPPER" kanban list >"$out" 2>"$err"
      ;;
    projects.db)
      HERMES_HOME="$home" "$WRAPPER" project list >"$out" 2>"$err"
      ;;
  esac
}

note "probe_optional_conversion: scratch_root=$ROOT"
note "probe_optional_conversion: hermes_src=$HERMES_SRC"
note "probe_optional_conversion: python=$($PYTHON --version 2>&1)"
note "probe_optional_conversion: hermes=$("$HERMES_BIN" --version 2>&1 | head -n 1)"
note "probe_optional_conversion: real_home=$REAL_HOME (never opened by design)"
note "probe_optional_conversion: header_reader=$READ_HEADER (raw bytes 18/19 only; no SQLite connection)"
note "probe_optional_conversion: host_native=/proc/1/cgroup=$(tr '\n' ' ' < /proc/1/cgroup 2>/dev/null)"

for STORE in kanban.db projects.db; do
  SLUG="${STORE%.db}"
  STORE_START_FAILURES=$FAILURES
  STORE_ROOT="$ROOT/$SLUG"
  SEED_HOME="$STORE_ROOT/seed-wal/home"
  CONVERSION_DIR="$STORE_ROOT/conversion"
  CONV_DB="$CONVERSION_DIR/$STORE"
  DELETE_HOME="$STORE_ROOT/delete/home"
  CONTROL_HOME="$STORE_ROOT/wal-control/home"
  mkdir -p "$SEED_HOME" "$CONVERSION_DIR" "$DELETE_HOME" "$CONTROL_HOME"

  note ""
  note "########################################################################"
  note "== $STORE =="
  note "########################################################################"

  # ── 1. Seed a real WAL store through the store's own trigger ──────────────
  note ""
  note "== $STORE 1. Seed a real store under database.journal_mode: wal =="
  write_config "$SEED_HOME" wal
  note "config_path: $SEED_HOME/config.yaml"
  note "config_realpath: $(readlink -f -- "$SEED_HOME/config.yaml")"
  confirm_resolved_mode "$SEED_HOME" wal
  run_store_writer "$STORE" "$SEED_HOME" "$STORE_ROOT/seed-writer.out" "$STORE_ROOT/seed-writer.err"
  SEED_RC=$?
  note "writer_exit: $SEED_RC"
  note "writer_stdout: $(tr '\n' '|' < "$STORE_ROOT/seed-writer.out")"
  note "writer_stderr: $(tr '\n' '|' < "$STORE_ROOT/seed-writer.err")"
  if [ "$SEED_RC" -ne 0 ]; then
    fail "$STORE seed writer failed (exit $SEED_RC)"
  fi
  measure_assert "seed_wal_${SLUG}" "$SEED_HOME/$STORE" "2 2" "wal" || true
  ORIGINAL_SHA="$(sha256_of "$SEED_HOME/$STORE")"
  note "original_sha256: $ORIGINAL_SHA"
  note "original_size: $(stat -c '%s' "$SEED_HOME/$STORE")"

  # ── 2. Copy with cp -a and prove byte identity before conversion ──────────
  note ""
  note "== $STORE 2. Copy the WAL store with cp -a and prove the copy is byte-identical =="
  note "command: cp -a -- $SEED_HOME/$STORE $CONV_DB"
  cp -a -- "$SEED_HOME/$STORE" "$CONV_DB"
  COPY_SHA_BEFORE="$(sha256_of "$CONV_DB")"
  note "copy_sha256: $COPY_SHA_BEFORE"
  measure_assert "conversion_copy_before_${SLUG}" "$CONV_DB" "2 2" "wal" || true
  if [ "$COPY_SHA_BEFORE" = "$ORIGINAL_SHA" ] && cmp -s -- "$SEED_HOME/$STORE" "$CONV_DB"; then
    pass "$STORE copy equals original before conversion (sha256 $COPY_SHA_BEFORE)"
  else
    fail "$STORE copy does not equal original before conversion (original $ORIGINAL_SHA, copy $COPY_SHA_BEFORE)"
  fi

  # ── 3. Offline conversion on the copy with the supported command ──────────
  note ""
  note "== $STORE 3. Convert the COPY offline with 'hermes sessions set-journal-mode delete' =="
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
    fail "$STORE offline conversion command failed (exit $CONVERT_RC)"
  fi
  measure_assert "converted_copy_${SLUG}" "$CONV_DB" "1 1" "delete" || true

  ORIGINAL_SHA_AFTER="$(sha256_of "$SEED_HOME/$STORE")"
  note "original_sha256_before_conversion: $ORIGINAL_SHA"
  note "original_sha256_after_conversion:  $ORIGINAL_SHA_AFTER"
  if [ "$ORIGINAL_SHA_AFTER" = "$ORIGINAL_SHA" ]; then
    pass "$STORE original WAL store sha256 is unchanged by conversion of the copy"
  else
    fail "$STORE original WAL store changed during conversion (before $ORIGINAL_SHA, after $ORIGINAL_SHA_AFTER)"
  fi
  CONVERTED_COPY_SHA="$(sha256_of "$CONV_DB")"
  note "converted_copy_sha256: $CONVERTED_COPY_SHA"

  # ── 4. Next writer TWICE under database.journal_mode: delete ──────────────
  note ""
  note "== $STORE 4. Trigger TWICE against the converted copy under database.journal_mode: delete =="
  write_config "$DELETE_HOME" delete
  note "config_path: $DELETE_HOME/config.yaml"
  note "config_realpath: $(readlink -f -- "$DELETE_HOME/config.yaml")"
  note "command: cp -a -- $CONV_DB $DELETE_HOME/$STORE"
  cp -a -- "$CONV_DB" "$DELETE_HOME/$STORE"
  confirm_resolved_mode "$DELETE_HOME" delete
  for run in 1 2; do
    note ""
    note "writer_run: $run (database.journal_mode=delete)"
    run_store_writer "$STORE" "$DELETE_HOME" \
      "$STORE_ROOT/delete-writer-$run.out" "$STORE_ROOT/delete-writer-$run.err"
    WRITER_RC=$?
    note "writer_exit: $WRITER_RC"
    note "writer_stdout: $(tr '\n' '|' < "$STORE_ROOT/delete-writer-$run.out")"
    note "writer_stderr: $(tr '\n' '|' < "$STORE_ROOT/delete-writer-$run.err")"
    if [ "$WRITER_RC" -ne 0 ]; then
      fail "$STORE delete-home writer run $run failed (exit $WRITER_RC)"
    fi
    measure_assert "delete_run_${run}_${SLUG}" "$DELETE_HOME/$STORE" "1 1" "delete" || true
    printf '%s\n' "$LAST_SHA" > "$STORE_ROOT/delete-run-$run.sha"
  done
  note "delete_home_sha256_after_run1: $(cat "$STORE_ROOT/delete-run-1.sha" 2>/dev/null || echo unknown)"
  note "delete_home_sha256_after_run2: $(cat "$STORE_ROOT/delete-run-2.sha" 2>/dev/null || echo unknown)"

  # ── 5. WAL control: same converted copy, configured wal, one writer ───────
  note ""
  note "== $STORE 5. Control: SAME converted copy under database.journal_mode: wal, trigger ONCE =="
  note "purpose: prove the CONFIGURED value, not the conversion, decides the next open"
  write_config "$CONTROL_HOME" wal
  note "config_path: $CONTROL_HOME/config.yaml"
  note "config_realpath: $(readlink -f -- "$CONTROL_HOME/config.yaml")"
  note "command: cp -a -- $CONV_DB $CONTROL_HOME/$STORE"
  cp -a -- "$CONV_DB" "$CONTROL_HOME/$STORE"
  confirm_resolved_mode "$CONTROL_HOME" wal
  note "writer_run: control (database.journal_mode=wal)"
  run_store_writer "$STORE" "$CONTROL_HOME" \
    "$STORE_ROOT/control-writer.out" "$STORE_ROOT/control-writer.err"
  CONTROL_RC=$?
  note "writer_exit: $CONTROL_RC"
  note "writer_stdout: $(tr '\n' '|' < "$STORE_ROOT/control-writer.out")"
  note "writer_stderr: $(tr '\n' '|' < "$STORE_ROOT/control-writer.err")"
  if [ "$CONTROL_RC" -ne 0 ]; then
    fail "$STORE wal-control trigger failed (exit $CONTROL_RC)"
  fi
  measure_assert "wal_control_run_${SLUG}" "$CONTROL_HOME/$STORE" "2 2" "wal" || true
  note "wal_control_sha256: $(sha256_of "$CONTROL_HOME/$STORE")"
  note "CONTROL: the converted 1,1 copy became 2,2 again because database.journal_mode=wal"
  note "CONTROL: was configured for this home. The WAL control is config-driven, not a"
  note "CONTROL: delete-mode failure."

  # ── 6. Conversion source integrity ────────────────────────────────────────
  note ""
  note "== $STORE 6. Conversion source integrity =="
  FINAL_CONVERTED_SHA="$(sha256_of "$CONV_DB")"
  note "converted_copy_sha256_before_writers: $CONVERTED_COPY_SHA"
  note "converted_copy_sha256_after_writers:  $FINAL_CONVERTED_SHA"
  if [ "$FINAL_CONVERTED_SHA" = "$CONVERTED_COPY_SHA" ]; then
    pass "$STORE conversion source copy was untouched by the writer/control homes"
  else
    fail "$STORE conversion source copy changed (before $CONVERTED_COPY_SHA, after $FINAL_CONVERTED_SHA)"
  fi
  FINAL_ORIGINAL_SHA="$(sha256_of "$SEED_HOME/$STORE")"
  note "original_wal_sha256_final: $FINAL_ORIGINAL_SHA"
  if [ "$FINAL_ORIGINAL_SHA" = "$ORIGINAL_SHA" ]; then
    pass "$STORE original WAL store sha256 is still unchanged at the end"
  else
    fail "$STORE original WAL store changed at the end (expected $ORIGINAL_SHA, got $FINAL_ORIGINAL_SHA)"
  fi

  if [ "$FAILURES" -eq "$STORE_START_FAILURES" ]; then
    note "$STORE VERDICT: HONOURING"
  else
    note "$STORE VERDICT: NOT-HONOURING / UNKNOWN ($((FAILURES - STORE_START_FAILURES)) failed assertion(s))"
  fi
done

# ── 7. Summary ──────────────────────────────────────────────────────────────
note ""
note "== optional-store offline-conversion persistence verdict =="
printf '%-16s %-10s %-10s %-12s %s\n' "store" "header" "mode" "next_writers" "result"
if [ "$FAILURES" -eq 0 ]; then
  printf '%-16s %-10s %-10s %-12s %s\n' "kanban.db" "1,1" "delete" "2" "kept rollback"
  printf '%-16s %-10s %-10s %-12s %s\n' "projects.db" "1,1" "delete" "2" "kept rollback"
  printf '%-16s %-10s %-10s %-12s %s\n' "both WAL controls" "2,2" "wal" "1" "config-driven"
  note ""
  note "KANBAN.DB VERDICT: HONOURING"
  note "PROJECTS.DB VERDICT: HONOURING"
  note "Both optional stores were created WAL (2,2), converted offline on copies to"
  note "rollback (1,1), and stayed 1,1 across two consecutive real trigger runs under"
  note "database.journal_mode=delete; their WAL controls flipped the same copies to 2,2."
else
  note ""
  note "OPTIONAL-STORE VERDICT: NOT-HONOURING / UNKNOWN ($FAILURES failed assertion(s))"
fi

note ""
note "native_execution: /proc/1/cgroup=$(cat /proc/1/cgroup 2>/dev/null | tr '\n' ' ')"
if [ "$FAILURES" -ne 0 ]; then
  note "RESULT: FAIL ($FAILURES assertion(s) failed)"
  exit 1
fi
note "RESULT: PASS (kanban.db and projects.db conversions persist across two delete-mode trigger runs; WAL controls flip to 2,2)"
if [ "$KEEP" = "0" ]; then
  note "scratch root removed on exit"
else
  note "scratch root kept: $ROOT"
fi
exit 0
