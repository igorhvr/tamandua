#!/bin/bash
# probe_fresh_modes.sh — measure the header of a FRESHLY created store under
# database.journal_mode=delete, with a database.journal_mode=wal control.
#
# For every inventoried store this script creates two disposable HERMES_HOME
# directories from the same scratch root:
#
#   <store>-delete/home   config.yaml: database.journal_mode: delete
#   <store>-wal/home      config.yaml: database.journal_mode: wal   (control)
#
# It confirms the home resolves to the intended journal mode BEFORE running the
# store's real writer, closes the writer, and then reads the journal format
# solely with read_header.py (raw header bytes 18/19).  It never connects
# through SQLite to read the mode: a connection can checkpoint a WAL and change
# the thing being measured.
#
# Writers exercised (the same real paths US-003 attributed):
#   state.db                  SessionDB() + create_session()
#   verification_evidence.db  record_verify_run() with HERMES_VERIFY_ON_STOP=1
#   kanban.db                 hermes kanban list
#   projects.db               hermes project list
#
# A fresh-creation verdict is HONOURING only when the delete home yields header
# bytes 1,1 AND the wal control yields 2,2.  Any other result prints the exact
# reading and the script exits nonzero.
#
# Usage:
#   ./probe_fresh_modes.sh
#
# Environment:
#   HERMES_SRC       installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_FRESH_ROOT    reuse a caller-created /tmp/g1-* root instead of mktemp
#   G1_KEEP_SCRATCH  set to 1 to keep a self-created root for inspection
#
# Safety: every home lives under a mktemp-created /tmp/g1-* directory, HOME is
# redirected into that scratch tree, and every Hermes CLI call goes through
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
    printf 'probe_fresh_modes: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

if [ -n "${G1_FRESH_ROOT:-}" ]; then
  ROOT="$G1_FRESH_ROOT"
  mkdir -p "$ROOT"
  KEEP=1
else
  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-fresh.XXXXXX")" || exit 2
  if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
    KEEP=1
  else
    KEEP=0
    trap 'rm -rf -- "$ROOT"' EXIT
  fi
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'probe_fresh_modes: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
    exit 64
    ;;
esac

# A scratch HOME removes the last Path.home() fallback path to ~/.hermes.
OPERATOR_HOME="$ROOT/operator-home"
mkdir -p "$OPERATOR_HOME"
export HOME="$OPERATOR_HOME"

# Never inherit a store-routing or journal-mode override from the invoking
# daemon.  HERMES_VERIFY_ON_STOP is set explicitly only for the
# verification_evidence.db writer below.
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

# Read one store's header with read_header.py only and record every field the
# story requires: sha256, byte18/byte19, mode, size, and sidecars.
measure_store() {
  local store="$1" home="$2" db="$home/$1"
  local header_json size sha byte18 byte19 mode
  if [ ! -f "$db" ]; then
    fail "$store was not created by its writer in $home"
    return
  fi
  header_json="$("$PYTHON" "$READ_HEADER" "$db" 2>/dev/null)" || {
    fail "$store: read_header.py failed on $db"
    return
  }
  size="$(json_field "$header_json" size)"
  sha="$(json_field "$header_json" sha256)"
  byte18="$(json_field "$header_json" byte18)"
  byte19="$(json_field "$header_json" byte19)"
  mode="$(json_field "$header_json" mode)"
  note "header_json: $header_json"
  note "store_path: $db"
  note "store_size: $size"
  note "store_sha256: $sha"
  note "byte18: $byte18"
  note "byte19: $byte19"
  note "observed_mode: $mode"
  note "journal_sidecars:"
  local sidecars
  sidecars="$(find "$home" -maxdepth 1 -type f \
    \( -name "$store-wal" -o -name "$store-shm" -o -name "$store-journal" \) \
    -printf '%f\t%s\n' 2>/dev/null | sort)"
  if [ -z "$sidecars" ]; then note "  (none)"; else printf '%s\n' "$sidecars" | sed 's/^/  /'; fi
  note "related_files (ls -la, store prefix only):"
  find "$home" -maxdepth 1 -type f -name "$store*" -printf '%M\t%10s\t%f\n' 2>/dev/null \
    | sort | sed 's/^/  /'
  # Echo the parsed pair for the caller; no SQLite connection was involved.
  printf '%s %s\n' "$byte18" "$byte19" > "$home/.g1-header-pair"
}

run_state_writer() {
  local home="$1"
  ( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c \
    'from hermes_state import SessionDB
db = SessionDB()
db.create_session(session_id="g1-fresh-state", source="cli")
db.close()
print("SessionDB created state.db")' )
}

run_verification_writer() {
  local home="$1"
  ( cd "$HERMES_SRC" && HERMES_HOME="$home" HERMES_VERIFY_ON_STOP=1 "$PYTHON" -c \
    'from agent.verification_evidence import record_verify_run
result = record_verify_run(root="'"$home"'/workspace", ok=True)
assert result, "record_verify_run returned no event"
print("record_verify_run id:", result.get("id"))' )
}

run_kanban_writer() {
  local home="$1"
  HERMES_HOME="$home" "$WRAPPER" kanban list
}

run_projects_writer() {
  local home="$1"
  HERMES_HOME="$home" "$WRAPPER" project list
}

run_writer() {
  local store="$1" home="$2"
  case "$store" in
    state.db)                 run_state_writer "$home" ;;
    verification_evidence.db) run_verification_writer "$home" ;;
    kanban.db)                run_kanban_writer "$home" ;;
    projects.db)              run_projects_writer "$home" ;;
    *) fail "unknown store '$store'"; return 1 ;;
  esac
}

# Probe one (store, config mode) pair.  Sets PAIR_<store>_<mode> to "b18 b19"
# and PAIR_MODE_<store>_<mode> to the observed mode string.
probe_pair() {
  local store="$1" config_mode="$2"
  local slug="${store%.db}"
  local home="$ROOT/${slug}-${config_mode}/home"
  local out="$ROOT/${slug}-${config_mode}/writer.out"
  local err="$ROOT/${slug}-${config_mode}/writer.err"
  mkdir -p "$home" "$(dirname "$out")"

  note ""
  note "### store: $store config: $config_mode"
  note "hermes_home: $home"
  write_config "$home" "$config_mode"
  note "config_path: $home/config.yaml"
  note "config_realpath: $(readlink -f -- "$home/config.yaml")"
  note "config_contents: $(tr '\n' '|' < "$home/config.yaml")"
  confirm_resolved_mode "$home" "$config_mode"

  note "writer: $(case "$store" in
    state.db) echo 'SessionDB() + create_session()' ;;
    verification_evidence.db) echo 'record_verify_run() with HERMES_VERIFY_ON_STOP=1' ;;
    kanban.db) echo 'hermes kanban list' ;;
    projects.db) echo 'hermes project list' ;;
  esac)"
  run_writer "$store" "$home" >"$out" 2>"$err"
  local rc=$?
  note "writer_exit: $rc"
  note "writer_stdout: $(tr '\n' '|' < "$out")"
  note "writer_stderr: $(grep -E 'hermes_scratch|hermes:' "$err" | head -n 2 | tr '\n' '|' || true)"
  if [ "$rc" -ne 0 ]; then
    fail "$store writer failed in $home (exit $rc)"
  fi

  measure_store "$store" "$home"

  local pair mode
  if [ -f "$home/.g1-header-pair" ]; then
    pair="$(cat "$home/.g1-header-pair")"
    mode="$(json_field "$("$PYTHON" "$READ_HEADER" "$home/$store" 2>/dev/null)" mode)" || mode=""
    eval "PAIR_${slug//-/_}_${config_mode//-/_}=\"\$pair\""
    eval "PAIR_MODE_${slug//-/_}_${config_mode//-/_}=\"\$mode\""
  fi
}

note "probe_fresh_modes: scratch_root=$ROOT"
note "probe_fresh_modes: hermes_src=$HERMES_SRC"
note "probe_fresh_modes: python=$($PYTHON --version 2>&1)"
note "probe_fresh_modes: hermes=$("$HERMES_BIN" --version 2>&1 | head -n 1)"
note "probe_fresh_modes: real_home=$REAL_HOME (never opened by design)"
note "probe_fresh_modes: header_reader=$READ_HEADER (raw bytes 18/19 only; no SQLite connection)"

STORES=(state.db verification_evidence.db kanban.db projects.db)

for store in "${STORES[@]}"; do
  probe_pair "$store" delete
  probe_pair "$store" wal
done

note ""
note "== Per-store fresh-creation verdicts =="
printf '%-28s %-14s %-14s %s\n' "store" "delete_header" "wal_header" "verdict"
VERDICT_ROWS=()
for store in "${STORES[@]}"; do
  slug="${store%.db}"; slug="${slug//-/_}"
  eval "delete_pair=\${PAIR_${slug}_delete:-?}"
  eval "wal_pair=\${PAIR_${slug}_wal:-?}"
  eval "delete_mode=\${PAIR_MODE_${slug}_delete:-?}"
  eval "wal_mode=\${PAIR_MODE_${slug}_wal:-?}"
  verdict="UNKNOWN"
  if [ "$delete_pair" = "1 1" ] && [ "$wal_pair" = "2 2" ]; then
    verdict="HONOURING"
    pass "$store fresh delete header is 1,1 and wal control is 2,2"
  elif [ "$delete_pair" = "1 1" ] && [ "$wal_pair" != "2 2" ]; then
    verdict="NOT-HONOURING"
    fail "$store delete header is 1,1 but wal control is '$wal_pair' (expected 2 2)"
  elif [ "$delete_pair" != "1 1" ]; then
    verdict="NOT-HONOURING"
    fail "$store delete header is '$delete_pair' (mode '$delete_mode'), expected 1 1"
  fi
  printf '%-28s %-14s %-14s %s\n' "$store" "$delete_pair" "$wal_pair" "$verdict"
  # Pipe-delimit the row: header byte pairs contain a space and must not be
  # word-split when the summary table is rendered.
  VERDICT_ROWS+=("$store|$delete_pair|$wal_pair|$verdict")
done

note ""
note "== Summary table =="
printf '%-28s %-13s %-13s %-13s %s\n' "store" "config_mode" "header_bytes" "observed_mode" "fresh_verdict"
for row in "${VERDICT_ROWS[@]}"; do
  IFS='|' read -r store delete_pair wal_pair verdict <<< "$row"
  slug="${store%.db}"
  eval "delete_mode=\${PAIR_MODE_${slug}_delete:-unknown}"
  eval "wal_mode=\${PAIR_MODE_${slug}_wal:-unknown}"
  printf '%-28s %-13s %-13s %-13s %s\n' "$store" "delete" "$delete_pair" "$delete_mode" "$verdict"
  printf '%-28s %-13s %-13s %-13s %s\n' "$store" "wal" "$wal_pair" "$wal_mode" "control"
done

if [ -r /proc/self/mountinfo ]; then
  note ""
  note "native_execution: /proc/1/cgroup=$(cat /proc/1/cgroup 2>/dev/null | tr '\n' ' ')"
fi

if [ "$FAILURES" -ne 0 ]; then
  note ""
  note "RESULT: FAIL ($FAILURES assertion(s) failed)"
  exit 1
fi
note ""
note "RESULT: PASS (every delete home created its store at 1,1; every wal control at 2,2)"
if [ "$KEEP" = "0" ]; then
  note "scratch root removed on exit"
else
  note "scratch root kept: $ROOT"
fi
exit 0
