#!/bin/bash
# probe_store_inventory.sh — derive the profile store set from observed behaviour.
#
# Every probe runs in its own disposable HERMES_HOME under a mktemp-created
# /tmp/g1-* directory, with HOME also redirected into that scratch tree so no
# Path.home() fallback can reach a real operator home.  Hermes CLI invocations
# go through hermes_scratch.sh, the single gateway that hard-refuses
# /home/kaladin/.hermes.
#
# The script answers one question: which SQLite stores does a trigger actually
# create on an otherwise empty profile?  It does not guess from *.db names; it
# runs the commands and enumerates what appeared, then reads journal format from
# raw header bytes 18/19 with read_header.py.
#
# Triggers probed (one fresh home each):
#   hermes doctor
#   hermes sessions list          (read-only by design: must NOT create state.db)
#   hermes kanban list
#   hermes projects list          (records the real CLI's "not a command" exit)
#   hermes project list           (the actual project command)
#   hermes cron list
#   SessionDB() + create_session  (direct writer -> state.db)
#   record_verify_run, verify-off (must return None and create no store)
#   record_verify_run, verify-on  (-> verification_evidence.db)
#
# Usage:
#   ./probe_store_inventory.sh
#
# Environment:
#   HERMES_SRC         installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_INVENTORY_ROOT  reuse a caller-created /tmp/g1-* root instead of mktemp
#   G1_KEEP_SCRATCH    set to 1 to keep a self-created root for inspection
#
# Exit 0 only when every store is attributable to a trigger and every
# "must not create" probe really left no store behind.

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
    printf 'probe_store_inventory: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

if [ -n "${G1_INVENTORY_ROOT:-}" ]; then
  ROOT="$G1_INVENTORY_ROOT"
  mkdir -p "$ROOT"
  KEEP=1
else
  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-inv.XXXXXX")" || exit 2
  if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
    KEEP=1
  else
    KEEP=0
    trap 'rm -rf -- "$ROOT"' EXIT
  fi
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'probe_store_inventory: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
    exit 64
    ;;
esac

# A scratch HOME removes the last Path.home() fallback path to ~/.hermes.
OPERATOR_HOME="$ROOT/operator-home"
mkdir -p "$OPERATOR_HOME"
export HOME="$OPERATOR_HOME"

# Never inherit a store-routing override from the invoking daemon.
unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_VERIFY_ON_STOP HERMES_JOURNAL_MODE

FAILURES=0

note() { printf '%s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); printf 'ASSERT FAIL: %s\n' "$*"; }

db_listing() {
  local home="$1"
  find "$home" -type f \( -name '*.db' -o -name '*-wal' -o -name '*-shm' \) \
    -printf '%P\t%s\n' 2>/dev/null | sort
}

db_paths() {
  local home="$1"
  find "$home" -type f -name '*.db' -printf '%P\n' 2>/dev/null | sort
}

print_headers() {
  local home="$1"
  local found=0
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    found=1
    "$PYTHON" "$READ_HEADER" "$home/$rel"
  done <<EOF
$(db_paths "$home")
EOF
  [ "$found" = "1" ] || note "  (no SQLite store)"
}

assert_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    note "ASSERT PASS: $label exists"
  else
    fail "$label did not create $path"
  fi
}

assert_absent() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then
    fail "$label must NOT create $path (it appeared)"
  else
    note "ASSERT PASS: $label did not create ${path#"$ROOT"/}"
  fi
}

run_cli() {
  local name="$1"; shift
  local home="$ROOT/$name/home"
  local out="$ROOT/$name/stdout.txt"
  local err="$ROOT/$name/stderr.txt"
  mkdir -p "$home"
  note ""
  note "### trigger: hermes $*"
  note "hermes_home: $home"
  HERMES_HOME="$home" timeout 180 "$WRAPPER" "$@" >"$out" 2>"$err"
  local rc=$?
  note "exit: $rc"
  note "stdout: $(head -n 1 "$out" 2>/dev/null || true)"
  note "stderr: $(grep -E 'hermes_scratch|hermes:' "$err" | head -n 3 | tr '\n' '|' || true)"
  note "db_files:"
  local listing
  listing="$(db_listing "$home")"
  if [ -z "$listing" ]; then note "  (none)"; else printf '%s\n' "$listing" | sed 's/^/  /'; fi
  note "headers:"
  print_headers "$home" | sed 's/^/  /'
  eval "EXIT_${name//-/_}=$rc"
  eval "HOME_${name//-/_}=\$home"
}

run_python_probe() {
  local name="$1" snippet="$2"
  shift 2
  local home="$ROOT/$name/home"
  local out="$ROOT/$name/stdout.txt"
  local err="$ROOT/$name/stderr.txt"
  mkdir -p "$home"
  note ""
  note "### trigger: python -c $1"
  note "hermes_home: $home"
  ( cd "$HERMES_SRC" && HERMES_HOME="$home" "$PYTHON" -c "$snippet" >"$out" 2>"$err" )
  local rc=$?
  note "exit: $rc"
  note "stdout: $(cat "$out" 2>/dev/null | tr '\n' '|' || true)"
  if [ -s "$err" ]; then note "stderr: $(tail -n 2 "$err" | tr '\n' '|')"; fi
  note "db_files:"
  local listing
  listing="$(db_listing "$home")"
  if [ -z "$listing" ]; then note "  (none)"; else printf '%s\n' "$listing" | sed 's/^/  /'; fi
  note "headers:"
  print_headers "$home" | sed 's/^/  /'
  eval "EXIT_${name//-/_}=$rc"
  eval "HOME_${name//-/_}=\$home"
}

note "probe_store_inventory: scratch_root=$ROOT"
note "probe_store_inventory: hermes_src=$HERMES_SRC"
note "probe_store_inventory: python=$($PYTHON --version 2>&1)"
note "probe_store_inventory: real_home=$REAL_HOME (never opened by design)"

run_cli doctor doctor
run_cli sessions-list sessions list
run_cli kanban-list kanban list
run_cli projects-list projects list
run_cli project-list project list
run_cli cron-list cron list

run_python_probe state-sessiondb \
  'from hermes_state import SessionDB
db = SessionDB()
db.create_session(session_id="g1-inventory", source="cli")
db.close()
print("SessionDB created state.db")' \
  'SessionDB(); create_session(session_id="g1-inventory")'

run_python_probe verification-off \
  'from agent.verification_evidence import record_verify_run
result = record_verify_run(root="'"$ROOT"'/verification-off/workspace", ok=True)
print("record_verify_run returned: %r" % (result,))' \
  'record_verify_run(ok=True) with verify-on-stop OFF'

run_python_probe verification-on \
  'import os
os.environ["HERMES_VERIFY_ON_STOP"] = "1"
from agent.verification_evidence import record_verify_run
result = record_verify_run(root="'"$ROOT"'/verification-on/workspace", ok=True)
print("record_verify_run returned id: %r" % ((result or {}).get("id"),))' \
  'record_verify_run(ok=True) with HERMES_VERIFY_ON_STOP=1'

note ""
note "== Attribution assertions =="
assert_exists "SessionDB() direct writer" "$HOME_state_sessiondb/state.db"
assert_absent "hermes sessions list (read-only)" "$HOME_sessions_list/state.db"
assert_absent "record_verify_run with verify-on-stop OFF" "$HOME_verification_off/verification_evidence.db"
assert_exists "record_verify_run with verify-on-stop ON" "$HOME_verification_on/verification_evidence.db"
assert_exists "hermes kanban list" "$HOME_kanban_list/kanban.db"
assert_exists "hermes project list" "$HOME_project_list/projects.db"
assert_absent "hermes cron list (jobs.json, not SQLite)" "$HOME_cron_list/cron.db"
assert_absent "hermes doctor (read-only health check)" "$HOME_doctor/state.db"

# The invalid plural spelling is recorded, not treated as a store trigger.
note "NOTE: 'hermes projects list' exited ${EXIT_projects_list:-?} (real CLI: not a command); no store asserted."

note ""
note "== Store inventory summary =="
printf '%-28s %-46s %s\n' "store (relative)" "trigger" "fresh-home"
printf '%-28s %-46s %s\n' "state.db" "SessionDB() + create_session()" "yes"
printf '%-28s %-46s %s\n' "verification_evidence.db" "record_verify_run() with verify-on-stop ON" "yes"
printf '%-28s %-46s %s\n' "kanban.db" "hermes kanban list" "yes"
printf '%-28s %-46s %s\n' "projects.db" "hermes project list" "yes"
printf '%-28s %-46s %s\n' "cron/jobs.json" "hermes cron list (JSON, not SQLite)" "n/a"

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
note "RESULT: PASS (all stores attributable; read-only triggers created no store)"
if [ "$KEEP" = "0" ]; then
  note "scratch root removed on exit"
else
  note "scratch root kept: $ROOT"
fi
exit 0
