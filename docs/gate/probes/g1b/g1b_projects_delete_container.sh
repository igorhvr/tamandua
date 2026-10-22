#!/bin/bash
# g1b_projects_delete_container.sh — CONTAINER-SIDE decisive experiment for
# ONE G1-B store: does the published image's stock Hermes honour
# `database.journal_mode: delete` across a real committed write, after an
# OFFLINE conversion of a real WAL store?
#
# This driver targets `projects.db`, the PER-PROFILE first-class Projects store
# (`hermes_cli/projects_db.py`).  It is not gated by a boolean and not gated by
# an opt-in flag, but it IS gated by USE: a default session never touches it, so
# the writer must be the real record-committing trigger
# `hermes project create "<marker>" --slug <marker>`.  `project list` is NOT an
# acceptable writer: it commits no record, so it could not support the bead's
# persistence assertion.  The trigger needs NO folder / `--primary` path — the
# stock command creates the project row without one — so no scratch repository
# (and never an operator path) is involved.
#
# Path-resolution nuance recorded by stage 0 (and needed to place the fixture
# store where the writer will actually open it):
#
#   get_hermes_home()  = context override -> HERMES_HOME env -> platform default
#   projects_db_path() = get_hermes_home() / "projects.db"
#
# `projects.db` is PER-PROFILE: a named profile
# (`HERMES_HOME=<root>/profiles/<name>`) resolves its own
# `<root>/profiles/<name>/projects.db`, NOT a store in the shared root (that
# shared-root rule belongs to `kanban.db`, the board store).  The fixture home
# here therefore IS the profile home and the store is
# `<fixture home>/projects.db`.  There is no projects-specific path override
# environment variable; only `HERMES_HOME` (or a context override) moves it, so
# the probe records that resolution instead of assuming a path.
#
# Invoked by probe_projects_delete.sh (the host orchestrator) through the single
# `g1b_container_run` gateway, so every path here is a container path under
# /work.  It never installs anything, never patches Hermes, and the only
# writable location is the bind-mounted scratch root.
#
# Stages (each prints KEY=value lines consumed by the host orchestrator):
#
#   0. PATH      prove the projects path resolution BEFORE anything is written:
#                the fixture home resolves as its own hermes home, the resolved
#                store is `<fixture home>/projects.db`, and a NAMED profile
#                resolves its OWN per-profile store (never the shared root).
#   1. SEED      real WAL store via the real writer under
#                `database.journal_mode: wal`; header 2,2.
#   2. COPY      `cp -a` aside, sha256 + `cmp -s` prove byte identity.
#   3. CONVERT   `hermes sessions set-journal-mode delete --db <copy>` on the
#                COPY only; raw header must be 1,1 and the original's sha256
#                must be unchanged.
#   4. DELETE    a fresh `cp -a` of the converted copy is placed in a home whose
#                config resolves to delete; the REAL trigger
#                (`hermes project create "<marker>" --slug <marker>`) runs TWICE
#                with two distinct markers.  After EACH close: the raw header
#                must be 1,1, all three sidecars must be absent, and a SEPARATE
#                read-only connection must find that run's identifiable
#                `projects` row (and prove the next marker absent).
#   5. CONTROL   the SAME converted copy under a config resolving to wal must
#                become 2,2.
#
# Journal format is measured ONLY with read_header.py (raw header bytes 18/19).
# The read-only SQLite connections exist solely for the persistence assertion
# and are opened with `mode=ro` + `PRAGMA query_only=ON` by g1b_readonly.py.
#
# Usage (container paths):
#   bash /work/tools/g1b_projects_delete_container.sh <seed-marker> \
#        <marker1> <marker2> <control-marker> <never-written-marker>
#
# Exit status: 0 when every stage of the fixture work completed (the host
# orchestrator owns the assertion verdict; a failed stage leaves its real exit
# code in the evidence).

set -u

MARK_SEED="${1:?seed marker}"
MARK1="${2:?writer run 1 marker}"
MARK2="${3:?writer run 2 marker}"
MARK_CONTROL="${4:?wal control marker}"
MARK_ABSENT="${5:?never-written marker}"

PYTHON=/opt/src/hermes-venv/bin/python
READ_HEADER=/work/tools/read_header.py
WRITERS=/work/tools/g1b_writers.py
READONLY=/work/tools/g1b_readonly.py
HERMES_BIN=/usr/local/bin/hermes

ROOT=/work/projects-delete
SEED_HOME="$ROOT/seed-wal/home"
CONV_DIR="$ROOT/conversion"
CONV_DB="$CONV_DIR/projects.db"
DELETE_HOME="$ROOT/delete/home"
CONTROL_HOME="$ROOT/wal-control/home"
PROFILE_HOME="$ROOT/profile-resolution/profiles/named"
SCRATCH=/work/scratch
LOGS=/work/logs

STORE=projects
DB_NAME=projects.db

mkdir -p -- "$SEED_HOME" "$CONV_DIR" "$DELETE_HOME" "$CONTROL_HOME" "$PROFILE_HOME" \
  "$SCRATCH" "$LOGS"
export HOME="/work/home"
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_JOURNAL_MODE HERMES_VERIFY_ON_STOP

printf 'STORE_KEY=%s\n' "$STORE"
printf 'STORE_DB_NAME=%s\n' "$DB_NAME"
printf 'SEED_HOME=%s\n' "$SEED_HOME"
printf 'CONVERSION_DB=%s\n' "$CONV_DB"
printf 'DELETE_HOME=%s\n' "$DELETE_HOME"
printf 'CONTROL_HOME=%s\n' "$CONTROL_HOME"
printf 'PROFILE_HOME=%s\n' "$PROFILE_HOME"
printf 'MARKER_SEED=%s\n' "$MARK_SEED"
printf 'MARKER_1=%s\n' "$MARK1"
printf 'MARKER_2=%s\n' "$MARK2"
printf 'MARKER_CONTROL=%s\n' "$MARK_CONTROL"
printf 'MARKER_NEVER_WRITTEN=%s\n' "$MARK_ABSENT"

# ---------------------------------------------------------------------------
# Fixture config (a CONFIGURATION write, never a journal-mode pragma)
# ---------------------------------------------------------------------------
write_config() {
  local home="$1" mode="$2"
  mkdir -p -- "$home"
  printf 'database:\n  journal_mode: %s\n' "$mode" > "$home/config.yaml"
  printf 'CONFIG path=%s content=%s\n' "$home/config.yaml" "$(tr '\n' '|' < "$home/config.yaml")"
}

# Confirm the home resolves to the intended mode BEFORE any writer runs.  This
# is an in-process read of the configured value, not a journal-mode query.
resolve_mode() {
  local label="$1" home="$2" out rc
  out="$( cd /opt/src/hermes-agent && HERMES_HOME="$home" "$PYTHON" -c \
    'from hermes_state_wal import resolve_journal_mode; print(resolve_journal_mode())' 2>&1 )"
  rc=$?
  printf '%s_RESOLVED_MODE=%s\n' "$label" "$(printf '%s\n' "$out" | tail -n 1)"
  printf '%s_RESOLVED_MODE_RC=%s\n' "$label" "$rc"
}

# Stock purity: the image's own checkout, unmodified (revision + porcelain).
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

# Journal format from RAW header bytes only (read_header.py); never SQLite.
measure() {
  local label="$1" db="$2" json rc field
  if [ ! -f "$db" ]; then
    printf '%s_EXISTS=no\n' "$label"
    return 1
  fi
  printf '%s_EXISTS=yes\n' "$label"
  printf '%s_PATH=%s\n' "$label" "$db"
  json="$("$PYTHON" "$READ_HEADER" "$db" 2>&1)"
  rc=$?
  printf '%s_RC=%s\n' "$label" "$rc"
  printf '%s_JSON=%s\n' "$label" "$json"
  for field in size sha256 byte18 byte19 mode; do
    printf '%s_%s=%s\n' "$label" "$(printf '%s' "$field" | tr '[:lower:]' '[:upper:]')" \
      "$(printf '%s' "$json" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$field" 2>/dev/null)"
  done
}

# All three sidecars, measured after the writer has CLOSED.
report_sidecars() {
  local label="$1" db="$2" pair name suffix path
  for pair in "WAL:-wal" "SHM:-shm" "JOURNAL:-journal"; do
    name="${pair%%:*}"
    suffix="${pair#*:}"
    path="$db$suffix"
    if [ -e "$path" ]; then
      printf '%s_SIDECAR_%s_STATE=present\n' "$label" "$name"
      printf '%s_SIDECAR_%s_SIZE=%s\n' "$label" "$name" "$(stat -c '%s' "$path")"
    else
      printf '%s_SIDECAR_%s_STATE=absent\n' "$label" "$name"
    fi
  done
}

record_field() {
  local log="$1" key="$2"
  grep -m1 "^$key=" "$log" | cut -d= -f2-
}

# Real writer through the store's own code path (g1b_writers.py projects ->
# `/usr/local/bin/hermes project create "<marker>" --slug <marker>`).
writer() {
  local label="$1" home="$2" marker="$3" rc log
  log="$LOGS/$label.writer.log"
  printf '%s_CMD=%s %s %s %s --home %s --scratch %s\n' \
    "$label" "$PYTHON" "$WRITERS" "$STORE" "$marker" "$home" "$SCRATCH"
  "$PYTHON" "$WRITERS" "$STORE" "$marker" --home "$home" --scratch "$SCRATCH" > "$log" 2>&1
  rc=$?
  printf '%s_EXIT=%s\n' "$label" "$rc"
  cat "$log"
  printf '%s_RECORD_TABLE=%s\n' "$label" "$(record_field "$log" WRITER_RECORD_TABLE)"
  printf '%s_RECORD_COLUMN=%s\n' "$label" "$(record_field "$log" WRITER_RECORD_COLUMN)"
  printf '%s_RECORD_ID=%s\n' "$label" "$(record_field "$log" WRITER_RECORD_ID)"
  printf '%s_RECORD_SLUG=%s\n' "$label" "$(record_field "$log" WRITER_RECORD_SLUG)"
  printf '%s_RECORD_NAME=%s\n' "$label" "$(record_field "$log" WRITER_RECORD_NAME)"
  return "$rc"
}

# Separate short-lived READ-ONLY connection (mode=ro + PRAGMA query_only=ON)
# used ONLY for the identifiable-record assertion.  It cannot write a row and
# never reads a journal mode.  `<table>` is the DISCOVERED project table.
readonly_check() {
  local label="$1" db="$2" marker="$3" table="$4" rc log count total matched
  log="$LOGS/$label.readonly.log"
  printf 'RO_%s_CMD=%s %s --db %s --marker %s\n' \
    "$label" "$PYTHON" "$READONLY" "$db" "$marker"
  "$PYTHON" "$READONLY" --db "$db" --marker "$marker" > "$log" 2>&1
  rc=$?
  printf 'RO_%s_EXIT=%s\n' "$label" "$rc"
  printf 'RO_%s_MARKER=%s\n' "$label" "$marker"
  cat "$log"
  count="$(grep -m1 "^READONLY_TABLE_COUNT table=$table " "$log" \
    | sed -n 's/.*count=\(-\{0,1\}[0-9][0-9]*\).*/\1/p')"
  total="$(grep -m1 '^READONLY_MATCH_COUNT_TOTAL=' "$log" | cut -d= -f2-)"
  matched="$(grep -m1 '^READONLY_MATCHED_TABLES=' "$log" | cut -d= -f2-)"
  printf 'RO_%s_PROJECT_COUNT=%s\n' "$label" "$count"
  printf 'RO_%s_TOTAL=%s\n' "$label" "$total"
  printf 'RO_%s_MATCHED_TABLES=%s\n' "$label" "$matched"
  return "$rc"
}

sha256_of() {
  sha256sum -- "$1" | awk '{print $1}'
}

printf 'PYTHON_VERSION=%s\n' "$("$PYTHON" --version 2>&1)"
printf 'HERMES_VERSION=%s\n' "$("$HERMES_BIN" --version 2>&1 | head -n 1)"
printf 'NATIVE_EXECUTION_CGROUP=%s\n' "$(tr '\n' ' ' < /proc/1/cgroup 2>/dev/null)"

check_stock STOCK

# ---------------------------------------------------------------------------
# 0. Prove the projects path resolution BEFORE anything is written, so the
#    fixture store is placed exactly where the writer opens it.
# ---------------------------------------------------------------------------
printf '\n== 0. prove projects path resolution (get_hermes_home()/projects_db_path()) ==\n'
write_config "$SEED_HOME" wal
resolve_mode PATH_CHECK "$SEED_HOME"

path_probe() {
  local label="$1" home="$2" out rc
  out="$( HERMES_HOME="$home" "$PYTHON" -c '
from hermes_cli.projects_db import projects_db_path
from hermes_constants import get_hermes_home
home = get_hermes_home()
db = projects_db_path()
print("PATH_HERMES_HOME=%s" % home)
print("PATH_PROJECTS_DB=%s" % db)
print("PATH_DB_PARENT=%s" % db.parent)
print("PATH_DB_NAME=%s" % db.name)
' 2>&1 )"
  rc=$?
  printf '%s_PATH_PROBE_RC=%s\n' "$label" "$rc"
  printf '%s\n' "$out" | sed "s/^/${label}_/"
  printf '%s_PATH_PROBE_EXIT=%s\n' "$label" "$rc"
}

path_probe DEFAULT_PROFILE "$SEED_HOME"
path_probe NAMED_PROFILE "$PROFILE_HOME"

printf 'PROJECTS_PATH_OVERRIDE_ENV=none (there is no projects-specific path override; projects_db_path() = get_hermes_home()/projects.db)\n'
printf 'PROJECTS_SLUG_NORMALIZATION=normalize_slug() lowercases the --slug argument; the marker is stored verbatim as projects.name, which is what the read-only check matches\n'

# ---------------------------------------------------------------------------
# 1. Seed a REAL WAL store with the real trigger (mode wal).
# ---------------------------------------------------------------------------
printf '\n== 1. seed a real projects.db under database.journal_mode: wal ==\n'
resolve_mode SEED "$SEED_HOME"
writer SEED "$SEED_HOME" "$MARK_SEED" || true
measure SEED "$SEED_HOME/$DB_NAME" || true
report_sidecars SEED "$SEED_HOME/$DB_NAME"
SEED_SHA="$(sha256_of "$SEED_HOME/$DB_NAME" 2>/dev/null)"
printf 'SEED_SHA256_HOST=%s\n' "$SEED_SHA"
SEED_RECORD_ID="$(record_field "$LOGS/SEED.writer.log" WRITER_RECORD_ID)"
# The project table is the one the stock writer itself reported, and it is then
# CONFIRMED by the read-only marker match below (discovery, never assumption).
SEED_RECORD_TABLE="$(record_field "$LOGS/SEED.writer.log" WRITER_RECORD_TABLE)"
printf 'SEED_RECORD_TABLE=%s\n' "$SEED_RECORD_TABLE"
printf 'SEED_RECORD_SLUG=%s\n' "$(record_field "$LOGS/SEED.writer.log" WRITER_RECORD_SLUG)"
printf 'SEED_RECORD_NAME=%s\n' "$(record_field "$LOGS/SEED.writer.log" WRITER_RECORD_NAME)"

# ---------------------------------------------------------------------------
# 2. cp -a the store aside; prove byte identity with sha256 + cmp -s.
# ---------------------------------------------------------------------------
printf '\n== 2. cp -a the WAL store aside and prove byte identity ==\n'
printf 'COPY_CMD=cp -a -- %s %s\n' "$SEED_HOME/$DB_NAME" "$CONV_DB"
cp -a -- "$SEED_HOME/$DB_NAME" "$CONV_DB"
printf 'COPY_RC=%s\n' "$?"
COPY_SHA_BEFORE="$(sha256_of "$CONV_DB")"
SEED_SHA_AT_COPY="$(sha256_of "$SEED_HOME/$DB_NAME")"
printf 'COPY_SHA256=%s\n' "$COPY_SHA_BEFORE"
printf 'SEED_SHA256_AT_COPY=%s\n' "$SEED_SHA_AT_COPY"
cmp -s -- "$SEED_HOME/$DB_NAME" "$CONV_DB"
printf 'COPY_CMP_RC=%s\n' "$?"
measure COPY_BEFORE "$CONV_DB" || true
report_sidecars COPY_BEFORE "$CONV_DB"
if [ "$COPY_SHA_BEFORE" = "$SEED_SHA_AT_COPY" ]; then
  printf 'COPY_BYTE_IDENTICAL=yes\n'
else
  printf 'COPY_BYTE_IDENTICAL=no\n'
fi

# ---------------------------------------------------------------------------
# 3. Convert ONLY the copy offline with the stock conversion command.
# ---------------------------------------------------------------------------
printf '\n== 3. convert ONLY the copy offline with `hermes sessions set-journal-mode delete` ==\n'
printf 'CONVERT_CMD=HERMES_HOME=%s %s sessions set-journal-mode delete --db %s\n' \
  "$SEED_HOME" "$HERMES_BIN" "$CONV_DB"
HERMES_HOME="$SEED_HOME" "$HERMES_BIN" sessions set-journal-mode delete --db "$CONV_DB" \
  > "$CONV_DIR/convert.stdout" 2> "$CONV_DIR/convert.stderr"
CONVERT_RC=$?
printf 'CONVERT_EXIT=%s\n' "$CONVERT_RC"
printf 'CONVERT_STDOUT=%s\n' "$(tr '\n' '|' < "$CONV_DIR/convert.stdout")"
printf 'CONVERT_STDERR=%s\n' "$(tr '\n' '|' < "$CONV_DIR/convert.stderr")"
measure CONVERTED "$CONV_DB" || true
report_sidecars CONVERTED "$CONV_DB"
CONVERTED_SHA="$(sha256_of "$CONV_DB")"
printf 'CONVERTED_SHA256=%s\n' "$CONVERTED_SHA"
SEED_SHA_AFTER_CONVERT="$(sha256_of "$SEED_HOME/$DB_NAME")"
printf 'SEED_SHA256_AFTER_CONVERT=%s\n' "$SEED_SHA_AFTER_CONVERT"
if [ "$SEED_SHA_AFTER_CONVERT" = "$SEED_SHA" ]; then
  printf 'SEED_UNCHANGED_BY_CONVERSION=yes\n'
else
  printf 'SEED_UNCHANGED_BY_CONVERSION=no\n'
fi
if [ "$CONVERTED_SHA" != "$COPY_SHA_BEFORE" ]; then
  printf 'CONVERSION_CHANGED_COPY=yes\n'
else
  printf 'CONVERSION_CHANGED_COPY=no\n'
fi

# ---------------------------------------------------------------------------
# 4. Fresh cp -a of the CONVERTED copy into a delete-resolving home; the real
#    trigger TWICE with two distinct markers, persistence asserted after close.
# ---------------------------------------------------------------------------
printf '\n== 4. real trigger TWICE under database.journal_mode: delete ==\n'
write_config "$DELETE_HOME" delete
printf 'PLACE_CMD=cp -a -- %s %s\n' "$CONV_DB" "$DELETE_HOME/$DB_NAME"
cp -a -- "$CONV_DB" "$DELETE_HOME/$DB_NAME"
printf 'PLACE_RC=%s\n' "$?"
resolve_mode DELETE "$DELETE_HOME"
measure DELETE_BEFORE "$DELETE_HOME/$DB_NAME" || true
report_sidecars DELETE_BEFORE "$DELETE_HOME/$DB_NAME"
# The converted copy still carries the seed record: prove the offline
# conversion preserved it (a weaker "opener returns" check would not), and
# discover the table the marker actually lives in (never assumed).
readonly_check DELETE_PRE_SEED "$DELETE_HOME/$DB_NAME" "$MARK_SEED" "$SEED_RECORD_TABLE"
PROJECTS_TABLE="$(grep -m1 '^READONLY_MATCHED_TABLES=' "$LOGS/DELETE_PRE_SEED.readonly.log" | cut -d= -f2-)"
printf 'EVIDENCE_TABLE=%s\n' "$PROJECTS_TABLE"
printf 'EVIDENCE_TABLE_WRITER_TABLE=%s\n' "$SEED_RECORD_TABLE"
printf 'EVIDENCE_TABLE_ROW_ID=%s\n' "$SEED_RECORD_ID"
printf 'EVIDENCE_TABLE_MARKER_COLUMN=name (the stored slug is the normalized marker)\n'
# Baseline: neither writer marker exists yet in THIS store.
readonly_check RUN1_BEFORE_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$PROJECTS_TABLE"
readonly_check RUN1_BEFORE_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$PROJECTS_TABLE"

writer RUN1 "$DELETE_HOME" "$MARK1" || true
measure RUN1 "$DELETE_HOME/$DB_NAME" || true
report_sidecars RUN1 "$DELETE_HOME/$DB_NAME"
readonly_check RUN1_AFTER_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$PROJECTS_TABLE"
readonly_check RUN1_AFTER_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$PROJECTS_TABLE"
measure RUN1_AFTER_READONLY "$DELETE_HOME/$DB_NAME" || true

readonly_check RUN2_BEFORE_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$PROJECTS_TABLE"
readonly_check RUN2_BEFORE_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$PROJECTS_TABLE"

writer RUN2 "$DELETE_HOME" "$MARK2" || true
measure RUN2 "$DELETE_HOME/$DB_NAME" || true
report_sidecars RUN2 "$DELETE_HOME/$DB_NAME"
readonly_check RUN2_AFTER_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$PROJECTS_TABLE"
readonly_check RUN2_AFTER_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$PROJECTS_TABLE"
measure RUN2_AFTER_READONLY "$DELETE_HOME/$DB_NAME" || true

# A marker that was NEVER written must stay absent.
readonly_check NEVER_WRITTEN "$DELETE_HOME/$DB_NAME" "$MARK_ABSENT" "$PROJECTS_TABLE"

# ---------------------------------------------------------------------------
# 5. WAL control: the SAME converted copy under a wal-resolving config.
# ---------------------------------------------------------------------------
printf '\n== 5. WAL control: SAME converted copy under database.journal_mode: wal ==\n'
write_config "$CONTROL_HOME" wal
printf 'CONTROL_PLACE_CMD=cp -a -- %s %s\n' "$CONV_DB" "$CONTROL_HOME/$DB_NAME"
cp -a -- "$CONV_DB" "$CONTROL_HOME/$DB_NAME"
printf 'CONTROL_PLACE_RC=%s\n' "$?"
resolve_mode CONTROL "$CONTROL_HOME"
measure CONTROL_BEFORE "$CONTROL_HOME/$DB_NAME" || true
report_sidecars CONTROL_BEFORE "$CONTROL_HOME/$DB_NAME"
readonly_check CONTROL_BEFORE_MARK "$CONTROL_HOME/$DB_NAME" "$MARK_CONTROL" "$PROJECTS_TABLE"
writer CONTROL "$CONTROL_HOME" "$MARK_CONTROL" || true
measure CONTROL "$CONTROL_HOME/$DB_NAME" || true
report_sidecars CONTROL "$CONTROL_HOME/$DB_NAME"
readonly_check CONTROL_AFTER_MARK "$CONTROL_HOME/$DB_NAME" "$MARK_CONTROL" "$PROJECTS_TABLE"
measure CONTROL_AFTER_READONLY "$CONTROL_HOME/$DB_NAME" || true

# ---------------------------------------------------------------------------
# 6. Integrity: conversion source untouched by both writer homes; the seeded
#    original still unchanged; stock purity after the runs.
# ---------------------------------------------------------------------------
printf '\n== 6. integrity and stock purity ==\n'
CONVERTED_SHA_AFTER="$(sha256_of "$CONV_DB")"
printf 'CONVERTED_SHA256_BEFORE_WRITERS=%s\n' "$CONVERTED_SHA"
printf 'CONVERTED_SHA256_AFTER_WRITERS=%s\n' "$CONVERTED_SHA_AFTER"
if [ "$CONVERTED_SHA_AFTER" = "$CONVERTED_SHA" ]; then
  printf 'CONVERSION_SOURCE_UNTOUCHED=yes\n'
else
  printf 'CONVERSION_SOURCE_UNTOUCHED=no\n'
fi
SEED_SHA_FINAL="$(sha256_of "$SEED_HOME/$DB_NAME")"
printf 'SEED_SHA256_FINAL=%s\n' "$SEED_SHA_FINAL"
if [ "$SEED_SHA_FINAL" = "$SEED_SHA" ]; then
  printf 'SEED_UNCHANGED_AT_END=yes\n'
else
  printf 'SEED_UNCHANGED_AT_END=no\n'
fi
check_stock STOCK_AFTER

printf 'PROJECTS_DELETE_CONTAINER_EXIT=0\n'
exit 0
