#!/bin/bash
# g1b_verification_delete_container.sh — CONTAINER-SIDE decisive experiment for
# ONE G1-B store: does the published image's stock Hermes honour
# `database.journal_mode: delete` across a real committed write, after an
# OFFLINE conversion of a real WAL store?
#
# This driver targets `verification_evidence.db`, the OPTIONAL verify-on-stop
# evidence ledger.  Because the ledger is opt-in, the driver FIRST proves the
# gate (stage 0) before it asserts anything about the store: a default session
# never touches `verification_evidence.db`, so a run without the gate enabled
# would prove nothing.
#
# Invoked by probe_verification_delete.sh (the host orchestrator) through the
# single `g1b_container_run` gateway, so every path here is a container path
# under /work.  It never installs anything, never patches Hermes, and the only
# writable location is the bind-mounted scratch root.
#
# Stages (each prints KEY=value lines consumed by the host orchestrator):
#
#   0. GATE      OFF  (no `agent.verify_on_stop`, no HERMES_VERIFY_ON_STOP):
#                     the guard is disabled, the stock writer returns None and
#                     the store is ABSENT before AND after the call.
#                ON   (`agent.verify_on_stop: true` in the fixture config): the
#                     guard is enabled, the writer returns a real event id and
#                     the store appears.
#                ENV  (`HERMES_VERIFY_ON_STOP=1`, the documented env form): same
#                     enabled/appears observations.
#                The evidence table is DISCOVERED from sqlite_master.
#   1. SEED      real WAL store via the real writer under
#                `database.journal_mode: wal` (+ the gate on); header 2,2.
#   2. COPY      `cp -a` aside, sha256 + `cmp -s` prove byte identity.
#   3. CONVERT   `hermes sessions set-journal-mode delete --db <copy>` on the
#                COPY only; raw header must be 1,1 and the original's sha256
#                must be unchanged.
#   4. DELETE    a fresh `cp -a` of the converted copy is placed in a home whose
#                config resolves to delete; the REAL writer
#                (`record_verify_run(session_id=<mark>, ok=True)`) runs TWICE
#                with two distinct markers.  After EACH close: the raw header
#                must be 1,1, all three sidecars must be absent, and a SEPARATE
#                read-only connection must find that run's identifiable
#                `verification_events` row (and prove the next marker absent).
#   5. CONTROL   the SAME converted copy under a config resolving to wal must
#                become 2,2.
#
# Journal format is measured ONLY with read_header.py (raw header bytes 18/19).
# The read-only SQLite connections exist solely for the persistence assertion
# and are opened with `mode=ro` + `PRAGMA query_only=ON` by g1b_readonly.py.
#
# Usage (container paths):
#   bash /work/tools/g1b_verification_delete_container.sh <seed-marker> \
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
GATE=/work/tools/g1b_verify_gate.py
HERMES_BIN=/usr/local/bin/hermes

ROOT=/work/verification-delete
GATE_OFF_HOME="$ROOT/gate-off/home"
GATE_ON_HOME="$ROOT/gate-on/home"
GATE_ENV_HOME="$ROOT/gate-env/home"
GATE_WORKSPACE="$ROOT/gate-workspace"
SEED_HOME="$ROOT/seed-wal/home"
CONV_DIR="$ROOT/conversion"
CONV_DB="$CONV_DIR/verification_evidence.db"
DELETE_HOME="$ROOT/delete/home"
CONTROL_HOME="$ROOT/wal-control/home"
SCRATCH=/work/scratch
LOGS=/work/logs

STORE=verification
DB_NAME=verification_evidence.db

mkdir -p -- "$GATE_OFF_HOME" "$GATE_ON_HOME" "$GATE_ENV_HOME" "$GATE_WORKSPACE" \
  "$SEED_HOME" "$CONV_DIR" "$DELETE_HOME" "$CONTROL_HOME" "$SCRATCH" "$LOGS"
export HOME="/work/home"
unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_JOURNAL_MODE HERMES_VERIFY_ON_STOP

printf 'STORE_KEY=%s\n' "$STORE"
printf 'STORE_DB_NAME=%s\n' "$DB_NAME"
printf 'GATE_OFF_HOME=%s\n' "$GATE_OFF_HOME"
printf 'GATE_ON_HOME=%s\n' "$GATE_ON_HOME"
printf 'GATE_ENV_HOME=%s\n' "$GATE_ENV_HOME"
printf 'SEED_HOME=%s\n' "$SEED_HOME"
printf 'CONVERSION_DB=%s\n' "$CONV_DB"
printf 'DELETE_HOME=%s\n' "$DELETE_HOME"
printf 'CONTROL_HOME=%s\n' "$CONTROL_HOME"
printf 'MARKER_SEED=%s\n' "$MARK_SEED"
printf 'MARKER_1=%s\n' "$MARK1"
printf 'MARKER_2=%s\n' "$MARK2"
printf 'MARKER_CONTROL=%s\n' "$MARK_CONTROL"
printf 'MARKER_NEVER_WRITTEN=%s\n' "$MARK_ABSENT"

# ---------------------------------------------------------------------------
# Fixture config (a CONFIGURATION write, never a journal-mode pragma)
# ---------------------------------------------------------------------------
write_config() {
  local home="$1" mode="$2" gate="${3:-off}"
  mkdir -p -- "$home"
  if [ "$gate" = "on" ]; then
    printf 'database:\n  journal_mode: %s\nagent:\n  verify_on_stop: true\n' \
      "$mode" > "$home/config.yaml"
  else
    printf 'database:\n  journal_mode: %s\n' "$mode" > "$home/config.yaml"
  fi
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

# ---------------------------------------------------------------------------
# Stage 0 — prove the opt-in gate BEFORE anything is asserted about the store.
# `g1b_verify_gate.py` prints the guard state, the stock writer's return value
# and whether the store exists; the host orchestrator asserts on those facts.
# ---------------------------------------------------------------------------
gate_check() {
  local label="$1" home="$2" workspace="$3" marker="$4" expect="$5" env_value="$6" rc log
  log="$LOGS/gate.$label.log"
  printf 'GATE_%s_CMD=%s%s %s --home %s --workspace %s --marker %s --expect %s\n' \
    "$label" \
    "$( [ -n "$env_value" ] && printf 'HERMES_VERIFY_ON_STOP=%s ' "$env_value" )" \
    "$PYTHON" "$GATE" "$home" "$workspace" "$marker" "$expect"
  if [ -n "$env_value" ]; then
    HERMES_VERIFY_ON_STOP="$env_value" "$PYTHON" "$GATE" \
      --home "$home" --workspace "$workspace" --marker "$marker" --expect "$expect" \
      > "$log" 2>&1
  else
    "$PYTHON" "$GATE" \
      --home "$home" --workspace "$workspace" --marker "$marker" --expect "$expect" \
      > "$log" 2>&1
  fi
  rc=$?
  printf 'GATE_%s_EXIT=%s\n' "$label" "$rc"
  cat "$log"
  printf 'GATE_%s_ENABLED=%s\n' "$label" "$(record_field "$log" GATE_ENABLED)"
  printf 'GATE_%s_ENABLED_MATCHES_EXPECT=%s\n' "$label" \
    "$(record_field "$log" GATE_ENABLED_MATCHES_EXPECT)"
  printf 'GATE_%s_RECORD_IS_NONE=%s\n' "$label" "$(record_field "$log" GATE_RECORD_IS_NONE)"
  printf 'GATE_%s_RECORD_ID=%s\n' "$label" "$(record_field "$log" GATE_RECORD_ID)"
  printf 'GATE_%s_DB_EXISTS_BEFORE=%s\n' "$label" "$(record_field "$log" GATE_DB_EXISTS_BEFORE)"
  printf 'GATE_%s_DB_EXISTS_AFTER=%s\n' "$label" "$(record_field "$log" GATE_DB_EXISTS_AFTER)"
  printf 'GATE_%s_EVIDENCE_TABLES=%s\n' "$label" "$(record_field "$log" GATE_EVIDENCE_TABLES)"
  printf 'GATE_%s_EVIDENCE_TABLE=%s\n' "$label" "$(record_field "$log" GATE_EVIDENCE_TABLE)"
  printf 'GATE_%s_MARKER_MATCHED_TABLES=%s\n' "$label" \
    "$(record_field "$log" GATE_MARKER_MATCHED_TABLES)"
  return "$rc"
}

# Real writer through the store's own code path (g1b_writers.py verification ->
# agent.verification_evidence.record_verify_run(session_id=<marker>, ok=True)).
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
  printf '%s_VERIFY_ON_STOP=%s\n' "$label" "$(record_field "$log" WRITER_VERIFY_ON_STOP)"
  printf '%s_VERIFY_WORKSPACE=%s\n' "$label" "$(record_field "$log" WRITER_VERIFY_WORKSPACE)"
  return "$rc"
}

# Separate short-lived READ-ONLY connection (mode=ro + PRAGMA query_only=ON)
# used ONLY for the identifiable-record assertion.  It cannot write a row and
# never reads a journal mode.  `<table>` is the DISCOVERED evidence table.
readonly_check() {
  local label="$1" db="$2" marker="$3" table="$4" rc log count total
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
  printf 'RO_%s_EVENTS_COUNT=%s\n' "$label" "$count"
  printf 'RO_%s_TOTAL=%s\n' "$label" "$total"
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
# 0. Prove the opt-in gate: OFF -> None + absent; CONFIG ON and ENV FORM ->
#    enabled + store appears.  The evidence table comes from sqlite_master.
# ---------------------------------------------------------------------------
printf '\n== 0. prove the verify-on-stop opt-in gate before the experiment ==\n'
write_config "$GATE_OFF_HOME" delete off
resolve_mode GATE_OFF "$GATE_OFF_HOME"
gate_check OFF "$GATE_OFF_HOME" "$GATE_WORKSPACE" "${MARK_SEED}-gate-off" disabled ""

write_config "$GATE_ON_HOME" delete on
resolve_mode GATE_ON "$GATE_ON_HOME"
gate_check CONFIG_ON "$GATE_ON_HOME" "$GATE_WORKSPACE" "${MARK_SEED}-gate-on" enabled ""

write_config "$GATE_ENV_HOME" delete off
resolve_mode GATE_ENV "$GATE_ENV_HOME"
gate_check ENV_FORM "$GATE_ENV_HOME" "$GATE_WORKSPACE" "${MARK_SEED}-gate-env" enabled 1

# The gate-on store is a fresh delete-mode ledger created by the enabled
# writer: record its raw header as supplementary evidence (asserted only as a
# fact, the experiment's own stages carry the verdict).
measure GATE_ON_DB "$GATE_ON_HOME/$DB_NAME" || true
report_sidecars GATE_ON_DB "$GATE_ON_HOME/$DB_NAME"
measure GATE_ENV_DB "$GATE_ENV_HOME/$DB_NAME" || true
report_sidecars GATE_ENV_DB "$GATE_ENV_HOME/$DB_NAME"

# The DISCOVERED evidence table (from sqlite_master) is what the persistence
# assertions count; no table name is invented by the probe.
EVENTS_TABLE="$(record_field "$LOGS/gate.CONFIG_ON.log" GATE_EVIDENCE_TABLE)"
printf 'EVIDENCE_TABLE=%s\n' "$EVENTS_TABLE"

# ---------------------------------------------------------------------------
# 1. Seed a REAL WAL store with the real writer (gate ON, mode wal).
# ---------------------------------------------------------------------------
printf '\n== 1. seed a real verification_evidence.db under database.journal_mode: wal ==\n'
write_config "$SEED_HOME" wal on
resolve_mode SEED "$SEED_HOME"
writer SEED "$SEED_HOME" "$MARK_SEED" || true
measure SEED "$SEED_HOME/$DB_NAME" || true
report_sidecars SEED "$SEED_HOME/$DB_NAME"
SEED_SHA="$(sha256_of "$SEED_HOME/$DB_NAME" 2>/dev/null)"
printf 'SEED_SHA256_HOST=%s\n' "$SEED_SHA"

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
# 4. Fresh cp -a of the CONVERTED copy into a delete-resolving home (gate on);
#    writer TWICE with two distinct markers, persistence asserted after close.
# ---------------------------------------------------------------------------
printf '\n== 4. real writer TWICE under database.journal_mode: delete (gate on) ==\n'
write_config "$DELETE_HOME" delete on
printf 'PLACE_CMD=cp -a -- %s %s\n' "$CONV_DB" "$DELETE_HOME/$DB_NAME"
cp -a -- "$CONV_DB" "$DELETE_HOME/$DB_NAME"
printf 'PLACE_RC=%s\n' "$?"
resolve_mode DELETE "$DELETE_HOME"
measure DELETE_BEFORE "$DELETE_HOME/$DB_NAME" || true
report_sidecars DELETE_BEFORE "$DELETE_HOME/$DB_NAME"
# The converted copy still carries the seed record: prove the offline
# conversion preserved it (a weaker "opener returns" check would not).
readonly_check DELETE_PRE_SEED "$DELETE_HOME/$DB_NAME" "$MARK_SEED" "$EVENTS_TABLE"
# Baseline: neither writer marker exists yet in THIS store.
readonly_check RUN1_BEFORE_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$EVENTS_TABLE"
readonly_check RUN1_BEFORE_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$EVENTS_TABLE"
# No probe write is performed between the placement baseline and run 1: the
# delete home's gate state is proven by the writer itself (g1b_writers.py raises
# when verify_on_stop is OFF and prints WRITER_VERIFY_ON_STOP=1 when it ran).
writer RUN1 "$DELETE_HOME" "$MARK1" || true
measure RUN1 "$DELETE_HOME/$DB_NAME" || true
report_sidecars RUN1 "$DELETE_HOME/$DB_NAME"
readonly_check RUN1_AFTER_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$EVENTS_TABLE"
readonly_check RUN1_AFTER_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$EVENTS_TABLE"
measure RUN1_AFTER_READONLY "$DELETE_HOME/$DB_NAME" || true

readonly_check RUN2_BEFORE_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$EVENTS_TABLE"
readonly_check RUN2_BEFORE_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$EVENTS_TABLE"

writer RUN2 "$DELETE_HOME" "$MARK2" || true
measure RUN2 "$DELETE_HOME/$DB_NAME" || true
report_sidecars RUN2 "$DELETE_HOME/$DB_NAME"
readonly_check RUN2_AFTER_MARK1 "$DELETE_HOME/$DB_NAME" "$MARK1" "$EVENTS_TABLE"
readonly_check RUN2_AFTER_MARK2 "$DELETE_HOME/$DB_NAME" "$MARK2" "$EVENTS_TABLE"
measure RUN2_AFTER_READONLY "$DELETE_HOME/$DB_NAME" || true

# A marker that was NEVER written must stay absent.
readonly_check NEVER_WRITTEN "$DELETE_HOME/$DB_NAME" "$MARK_ABSENT" "$EVENTS_TABLE"

# ---------------------------------------------------------------------------
# 5. WAL control: the SAME converted copy under a wal-resolving config.
# ---------------------------------------------------------------------------
printf '\n== 5. WAL control: SAME converted copy under database.journal_mode: wal ==\n'
write_config "$CONTROL_HOME" wal on
printf 'CONTROL_PLACE_CMD=cp -a -- %s %s\n' "$CONV_DB" "$CONTROL_HOME/$DB_NAME"
cp -a -- "$CONV_DB" "$CONTROL_HOME/$DB_NAME"
printf 'CONTROL_PLACE_RC=%s\n' "$?"
resolve_mode CONTROL "$CONTROL_HOME"
measure CONTROL_BEFORE "$CONTROL_HOME/$DB_NAME" || true
report_sidecars CONTROL_BEFORE "$CONTROL_HOME/$DB_NAME"
readonly_check CONTROL_BEFORE_MARK "$CONTROL_HOME/$DB_NAME" "$MARK_CONTROL" "$EVENTS_TABLE"
writer CONTROL "$CONTROL_HOME" "$MARK_CONTROL" || true
measure CONTROL "$CONTROL_HOME/$DB_NAME" || true
report_sidecars CONTROL "$CONTROL_HOME/$DB_NAME"
readonly_check CONTROL_AFTER_MARK "$CONTROL_HOME/$DB_NAME" "$MARK_CONTROL" "$EVENTS_TABLE"
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

printf 'VERIFICATION_DELETE_CONTAINER_EXIT=0\n'
exit 0
