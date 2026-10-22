#!/bin/bash
# g1b_seed_container.sh — CONTAINER-SIDE seeding driver for ONE G1-B store.
#
# Runs inside the published image (invoked by seed_stores.sh through
# g1b_container_run's single gateway) and seeds one store under
# `database.journal_mode: wal` using the store's REAL writer, twice, with two
# unique markers.  It then reports:
#
#   * the resolved journal mode (a CONFIGURATION read, never a journal-mode
#     query) before any writer runs;
#   * the stock-purity check (Hermes revision + `git status --porcelain`);
#   * per writer run: the real exit code, the store-assigned record identifier,
#     and the store's raw header bytes 18/19 / size / sha256 (read ONLY by
#     read_header.py, never through SQLite);
#   * all three sidecar states (-wal, -shm, -journal) after each writer close;
#   * the read-only persistence check for both written markers (must be present)
#     and for a marker that was never written (must be absent).
#
# Usage (container paths):
#   bash /work/tools/g1b_seed_container.sh <store> <db-name> <marker1> <marker2> <absent-marker>
#
# Nothing is installed, Hermes is never patched, and the only writable location
# is the bind-mounted scratch root (/work).

set -u

STORE="${1:?store key (state|verification|kanban|projects)}"
DB="${2:?store file name}"
MARK1="${3:?marker 1}"
MARK2="${4:?marker 2}"
ABSENT="${5:?absent marker}"

PYTHON=/opt/src/hermes-venv/bin/python
READ_HEADER=/work/tools/read_header.py
WRITERS=/work/tools/g1b_writers.py
READONLY=/work/tools/g1b_readonly.py
HOME_DIR="/work/homes/$STORE"
SCRATCH="/work/scratch"
LOGS="/work/logs"
STORE_DB="$HOME_DIR/$DB"

mkdir -p -- "$HOME_DIR" "$SCRATCH" "$LOGS"
export HOME="/work/home"
unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_JOURNAL_MODE HERMES_VERIFY_ON_STOP

printf 'STORE=%s\n' "$DB"
printf 'STORE_KEY=%s\n' "$STORE"
printf 'STORE_HOME=%s\n' "$HOME_DIR"
printf 'STORE_DB=%s\n' "$STORE_DB"
printf 'MARKER_1=%s\n' "$MARK1"
printf 'MARKER_2=%s\n' "$MARK2"
printf 'ABSENT_MARKER=%s\n' "$ABSENT"

# ---------------------------------------------------------------------------
# Fixture config: the writer must run under `database.journal_mode: wal`.
# verification_evidence.db is opt-in, so its home also enables the gate in
# config (the environment form HERMES_VERIFY_ON_STOP=1 is set by the writer).
# ---------------------------------------------------------------------------
if [ "$STORE" = "verification" ]; then
  printf 'database:\n  journal_mode: wal\nagent:\n  verify_on_stop: true\n' > "$HOME_DIR/config.yaml"
else
  printf 'database:\n  journal_mode: wal\n' > "$HOME_DIR/config.yaml"
fi
printf 'CONFIG_CONTENT=%s\n' "$(tr '\n' '|' < "$HOME_DIR/config.yaml")"

resolve_mode() {
  local out rc
  out="$( cd /opt/src/hermes-agent && HERMES_HOME="$HOME_DIR" "$PYTHON" -c \
    'from hermes_state_wal import resolve_journal_mode; print(resolve_journal_mode())' 2>&1 )"
  rc=$?
  printf 'RESOLVED_MODE=%s\n' "$(printf '%s\n' "$out" | tail -n 1)"
  printf 'RESOLVED_MODE_RC=%s\n' "$rc"
}
resolve_mode

# ---------------------------------------------------------------------------
# Stock purity: the image's own checkout, unmodified.  Checked BEFORE the
# writers and again AFTER them (the revision must be unchanged and the
# `git status --porcelain` still empty in both readings).
# ---------------------------------------------------------------------------
check_stock() {
  local prefix="$1" revision revision_rc status status_rc
  revision="$(git -c safe.directory=/opt/src/hermes-agent -C /opt/src/hermes-agent rev-parse HEAD 2>&1)"
  revision_rc=$?
  printf '%s_REVISION=%s\n' "$prefix" "$revision"
  printf '%s_REVISION_RC=%s\n' "$prefix" "$revision_rc"
  status="$(git -c safe.directory=/opt/src/hermes-agent -C /opt/src/hermes-agent status --porcelain 2>&1)"
  status_rc=$?
  if [ -z "$status" ]; then
    printf '%s_STATUS_PORCELAIN_EMPTY=yes\n' "$prefix"
  else
    printf '%s_STATUS_PORCELAIN_EMPTY=no\n' "$prefix"
    printf '%s\n' "$status"
  fi
  printf '%s_STATUS_RC=%s\n' "$prefix" "$status_rc"
}

check_stock STOCK

# ---------------------------------------------------------------------------
# Measurement: journal format from RAW header bytes only (read_header.py).
# Sidecars are reported separately from the header bytes.
# ---------------------------------------------------------------------------
measure() {
  local label="$1" db="$STORE_DB" json rc field
  if [ ! -f "$db" ]; then
    printf '%s_EXISTS=no\n' "$label"
    return 1
  fi
  printf '%s_EXISTS=yes\n' "$label"
  json="$("$PYTHON" "$READ_HEADER" "$db" 2>&1)"
  rc=$?
  printf '%s_RC=%s\n' "$label" "$rc"
  printf '%s_JSON=%s\n' "$label" "$json"
  for field in size sha256 byte18 byte19 mode; do
    printf '%s_%s=%s\n' "$label" "$(printf '%s' "$field" | tr '[:lower:]' '[:upper:]')" \
      "$(printf '%s' "$json" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$field" 2>/dev/null)"
  done
}

report_sidecars() {
  local label="$1" pair name suffix path
  for pair in "WAL:-wal" "SHM:-shm" "JOURNAL:-journal"; do
    name="${pair%%:*}"
    suffix="${pair#*:}"
    path="$STORE_DB$suffix"
    if [ -e "$path" ]; then
      printf '%s_SIDECAR_%s_STATE=present\n' "$label" "$name"
      printf '%s_SIDECAR_%s_SIZE=%s\n' "$label" "$name" "$(stat -c '%s' "$path")"
      printf '%s_SIDECAR_%s_SHA256=%s\n' "$label" "$name" "$(sha256sum "$path" | awk '{print $1}')"
    else
      printf '%s_SIDECAR_%s_STATE=absent\n' "$label" "$name"
    fi
  done
}

record_field() {
  local log="$1" key="$2"
  grep -m1 "^$key=" "$log" | cut -d= -f2-
}

# ---------------------------------------------------------------------------
# Real writer runs (TWICE, distinct unique markers).
# ---------------------------------------------------------------------------
run_writer() {
  local n="$1" marker="$2" rc
  local log="$LOGS/$STORE.writer$n.log"
  printf 'WRITER%s_CMD=%s %s %s %s --home %s --scratch %s\n' \
    "$n" "$PYTHON" "$WRITERS" "$STORE" "$marker" "$HOME_DIR" "$SCRATCH"
  "$PYTHON" "$WRITERS" "$STORE" "$marker" --home "$HOME_DIR" --scratch "$SCRATCH" >"$log" 2>&1
  rc=$?
  printf 'WRITER%s_EXIT=%s\n' "$n" "$rc"
  cat "$log"
  printf 'RECORD%s_TABLE=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_TABLE)"
  printf 'RECORD%s_COLUMN=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_COLUMN)"
  printf 'RECORD%s_ID=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_ID)"
  printf 'RECORD%s_TITLE=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_TITLE)"
  printf 'RECORD%s_SLUG=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_SLUG)"
  printf 'RECORD%s_NAME=%s\n' "$n" "$(record_field "$log" WRITER_RECORD_NAME)"
  return "$rc"
}

# ---------------------------------------------------------------------------
# Read-only persistence check (separate short-lived read-only connection).
# ---------------------------------------------------------------------------
readonly_check() {
  local label="$1" marker="$2" rc
  local log="$LOGS/$STORE.readonly.$label.log"
  printf 'READONLY_%s_CMD=%s %s --db %s --marker %s\n' \
    "$label" "$PYTHON" "$READONLY" "$STORE_DB" "$marker"
  "$PYTHON" "$READONLY" --db "$STORE_DB" --marker "$marker" >"$log" 2>&1
  rc=$?
  printf 'READONLY_%s_EXIT=%s\n' "$label" "$rc"
  cat "$log"
}

table_count() {
  local log="$1" table="$2"
  grep -m1 "^READONLY_TABLE_COUNT table=$table " "$log" | sed -n 's/.*count=\(-\{0,1\}[0-9][0-9]*\).*/\1/p'
}

total_count() {
  local log="$1"
  grep -m1 '^READONLY_MATCH_COUNT_TOTAL=' "$log" | cut -d= -f2-
}

run_writer 1 "$MARK1" || true
measure SEED1 || true
report_sidecars SEED1

run_writer 2 "$MARK2" || true
measure SEED2 || true
report_sidecars SEED2

check_stock STOCK_AFTER

RECORD1_TABLE="$(record_field "$LOGS/$STORE.writer1.log" WRITER_RECORD_TABLE)"
# Empty when the writer emitted nothing; the host asserts on that failure.
printf 'READONLY_RECORD_TABLE=%s\n' "$RECORD1_TABLE"

# Baseline read-only check BEFORE the marker evidence is claimed: the written
# markers are present and a marker that was never written is absent.
readonly_check MARK1 "$MARK1"
readonly_check MARK2 "$MARK2"
readonly_check NOTWRITTEN "$ABSENT"

printf 'READONLY_MARK1_TABLE_COUNT=%s\n' "$(table_count "$LOGS/$STORE.readonly.MARK1.log" "$RECORD1_TABLE")"
printf 'READONLY_MARK1_TOTAL=%s\n' "$(total_count "$LOGS/$STORE.readonly.MARK1.log")"
printf 'READONLY_MARK2_TABLE_COUNT=%s\n' "$(table_count "$LOGS/$STORE.readonly.MARK2.log" "$RECORD1_TABLE")"
printf 'READONLY_MARK2_TOTAL=%s\n' "$(total_count "$LOGS/$STORE.readonly.MARK2.log")"
printf 'READONLY_NOTWRITTEN_TABLE_COUNT=%s\n' "$(table_count "$LOGS/$STORE.readonly.NOTWRITTEN.log" "$RECORD1_TABLE")"
printf 'READONLY_NOTWRITTEN_TOTAL=%s\n' "$(total_count "$LOGS/$STORE.readonly.NOTWRITTEN.log")"

printf 'SEED_STORE_EXIT=0\n'
exit 0
