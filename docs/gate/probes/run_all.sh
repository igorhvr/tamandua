#!/bin/bash
# run_all.sh — end-to-end G1 store-control discovery harness.
#
# Runs the raw-header unit test and every probe script against a single fresh
# /tmp/g1-* scratch root, tees the complete output to
# docs/gate/evidence/final-harness.log, and exits nonzero if any step fails or
# any assertion fails.
#
# Steps:
#   01  test_read_header.py                 raw bytes 18/19 unit test
#   02  probe_config.py                     config path/realpath/winning layer
#   03  probe_store_inventory.sh            store set derived from behaviour
#   04  probe_fresh_modes.sh                fresh-store headers per store
#   05  probe_conversion_persistence.sh     state.db next-writer persistence
#   06  probe_verification_conversion.sh    verification_evidence.db persistence
#   07  probe_optional_conversion.sh        kanban.db / projects.db persistence
#
# Every step is run under `strace -f -e trace=openat,open,creat` when strace is
# available, and the safety summary records how many traced lines opened a path
# under /home/kaladin/.hermes.  The final section also scans every saved
# evidence text/log for an actual real-home open.  Mentions of the real home in
# design/safety notes are not opens and are not counted.
#
# Usage:
#   ./docs/gate/probes/run_all.sh
#
# Environment:
#   HERMES_SRC          installed Hermes tree (default /home/kaladin/hermes-agent)
#   G1_HARNESS_LOG      log path (default docs/gate/evidence/final-harness.log)
#   G1_HARNESS_STRACE   set to 0 to skip the strace wrapper (default 1)
#   G1_KEEP_SCRATCH     set to 1 to keep the fresh scratch root for inspection
#
# Safety: every probe creates and uses disposable homes under this run's
# /tmp/g1-* root, HOME is redirected into that root, and every Hermes CLI call
# still goes through hermes_scratch.sh, which hard-refuses /home/kaladin/.hermes.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$PROBES_DIR/../../.." && pwd)"
EVIDENCE_DIR="$PROJECT_ROOT/docs/gate/evidence"
LOG="${G1_HARNESS_LOG:-$EVIDENCE_DIR/final-harness.log}"
HERMES_SRC="${HERMES_SRC:-/home/kaladin/hermes-agent}"
PYTHON="$HERMES_SRC/venv/bin/python"
HERMES_BIN="$HERMES_SRC/venv/bin/hermes"
WRAPPER="$PROBES_DIR/hermes_scratch.sh"
REAL_HOME="/home/kaladin/.hermes"
USE_STRACE="${G1_HARNESS_STRACE:-1}"

for required in "$PYTHON" "$HERMES_BIN" "$WRAPPER" "$PROBES_DIR/read_header.py"; do
  if [ ! -e "$required" ]; then
    printf 'run_all: MISSING required path: %s\n' "$required" >&2
    exit 2
  fi
done

mkdir -p "$EVIDENCE_DIR"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/g1-final.XXXXXX")" || exit 2
if [ "${G1_KEEP_SCRATCH:-0}" = "1" ]; then
  KEEP=1
else
  KEEP=0
  trap 'rm -rf -- "$ROOT"' EXIT
fi

case "$(readlink -f -- "$ROOT")" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    printf 'run_all: REFUSED: scratch root resolves into the real operator home: %s\n' "$ROOT" >&2
    exit 64
    ;;
esac

mkdir -p "$ROOT/strace" "$ROOT/logs" "$ROOT/operator-home"
export HOME="$ROOT/operator-home"
export HERMES_BIN

# Point every probe that supports a caller-supplied root at this run's root.
# probe_config.py uses G1_CONFIG_ROOT; the shell probes use their own variable.
export G1_CONFIG_ROOT="$ROOT/config"
export G1_INVENTORY_ROOT="$ROOT/inventory"
export G1_FRESH_ROOT="$ROOT/fresh"
export G1_CONVERSION_ROOT="$ROOT/conversion"
export G1_VERIFICATION_ROOT="$ROOT/verification"
export G1_OPTIONAL_ROOT="$ROOT/optional"

# Never inherit a store-routing or journal-mode override from the invoking
# daemon.  Each probe sets what it needs explicitly.
unset HERMES_HOME HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD
unset HERMES_MANAGED_DIR HERMES_PROFILE HERMES_VERIFY_ON_STOP HERMES_JOURNAL_MODE

: > "$LOG"

FAILED_STEPS=0
STEPS=0
STRACE_STEPS=0
SAFETY_FILE="$ROOT/safety-counts.txt"
: > "$SAFETY_FILE"

note() { printf '%s\n' "$*"; }

emit() {
  printf '%s\n' "$*" | tee -a "$LOG"
}

run_step() {
  local name="$1" workdir="$2"
  shift 2
  local step_out="$ROOT/logs/$name.out"
  local raw="$ROOT/strace/$name.raw"
  local status real_home_open_lines

  STEPS=$((STEPS + 1))
  emit ""
  emit "===== $name ====="
  emit "workdir: $workdir"
  emit "command: $*"

  if [ "$USE_STRACE" = "1" ] && command -v strace >/dev/null 2>&1; then
    STRACE_STEPS=$((STRACE_STEPS + 1))
    ( cd "$workdir" && exec strace -f -e trace=openat,open,creat -o "$raw" -- "$@" ) \
      >"$step_out" 2>&1
    status=$?
  else
    ( cd "$workdir" && exec "$@" ) >"$step_out" 2>&1
    status=$?
  fi

  cat "$step_out" | tee -a "$LOG"
  emit "step_exit: $status"

  if [ "$status" -ne 0 ]; then
    FAILED_STEPS=$((FAILED_STEPS + 1))
    emit "STEP RESULT: FAIL ($name exited $status)"
  else
    emit "STEP RESULT: PASS ($name exited 0)"
  fi

  if grep -q 'ASSERT FAIL' "$step_out"; then
    FAILED_STEPS=$((FAILED_STEPS + 1))
    emit "STEP RESULT: FAIL ($name printed ASSERT FAIL)"
  fi

  real_home_open_lines=0
  if [ -f "$raw" ]; then
    real_home_open_lines="$(grep -Ec 'open(at)?\(.*"/home/kaladin/\.hermes' "$raw" || true)"
    emit "SAFETY: $name traced_lines=$(wc -l < "$raw") real_home_open_lines=$real_home_open_lines"
  else
    emit "SAFETY: $name strace=skipped real_home_open_lines=not-measured"
  fi
  printf '%s %s\n' "$name" "$real_home_open_lines" >> "$SAFETY_FILE"
}

emit "G1 consolidated harness"
emit "harness=$PROBES_DIR/run_all.sh"
emit "scratch_root=$ROOT"
emit "hermes_src=$HERMES_SRC"
emit "python=$($PYTHON --version 2>&1)"
emit "hermes=$("$HERMES_BIN" --version 2>&1 | head -n 1)"
emit "real_home=$REAL_HOME (never opened by design; opens are counted below)"
emit "host_native=/proc/1/cgroup=$(tr '\n' ' ' < /proc/1/cgroup 2>/dev/null)"
emit "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_step "01-header-unit-test" "$PROJECT_ROOT" \
  "$PYTHON" "$PROBES_DIR/test_read_header.py"

run_step "02-config-resolution" "$HERMES_SRC" \
  "$PYTHON" "$PROBES_DIR/probe_config.py"

run_step "03-store-inventory" "$PROJECT_ROOT" \
  /bin/bash "$PROBES_DIR/probe_store_inventory.sh"

run_step "04-fresh-store-modes" "$PROJECT_ROOT" \
  /bin/bash "$PROBES_DIR/probe_fresh_modes.sh"

run_step "05-state-conversion" "$PROJECT_ROOT" \
  /bin/bash "$PROBES_DIR/probe_conversion_persistence.sh"

run_step "06-verification-conversion" "$PROJECT_ROOT" \
  /bin/bash "$PROBES_DIR/probe_verification_conversion.sh"

run_step "07-optional-conversion" "$PROJECT_ROOT" \
  /bin/bash "$PROBES_DIR/probe_optional_conversion.sh"

# ── Cross-log safety scan ───────────────────────────────────────────────────
emit ""
emit "===== safety summary ====="
STRACE_TOTAL=0
while read -r step_name line_count; do
  [ -n "${step_name:-}" ] || continue
  case "$line_count" in
    ''|*[!0-9]*) continue ;;
  esac
  STRACE_TOTAL=$((STRACE_TOTAL + line_count))
done < "$SAFETY_FILE"
emit "SAFETY SUMMARY: steps=$STEPS straced_steps=$STRACE_STEPS"
emit "SAFETY SUMMARY: raw_strace_real_home_open_lines=$STRACE_TOTAL"

EVIDENCE_FILES=0
EVIDENCE_OPENS=0
while IFS= read -r evidence_file; do
  EVIDENCE_FILES=$((EVIDENCE_FILES + 1))
  count="$(grep -Ec 'open(at)?\(.*"/home/kaladin/\.hermes' "$evidence_file" || true)"
  if [ "$count" -ne 0 ]; then
    emit "SAFETY VIOLATION: $evidence_file real_home_open_lines=$count"
    EVIDENCE_OPENS=$((EVIDENCE_OPENS + count))
  fi
done < <(find "$EVIDENCE_DIR" -maxdepth 1 -type f \( -name '*.txt' -o -name '*.log' \) -print | sort)
emit "SAFETY SUMMARY: evidence_text_files=$EVIDENCE_FILES saved_log_real_home_open_lines=$EVIDENCE_OPENS"

if [ "$STRACE_TOTAL" -ne 0 ] || [ "$EVIDENCE_OPENS" -ne 0 ]; then
  FAILED_STEPS=$((FAILED_STEPS + 1))
  emit "SAFETY RESULT: FAIL — a probe opened a path under $REAL_HOME"
else
  emit "SAFETY RESULT: PASS — no open of any path under $REAL_HOME in the harness strace or saved logs"
fi

emit ""
if [ "$FAILED_STEPS" -ne 0 ]; then
  emit "RESULT: FAIL ($FAILED_STEPS failed step/assertion group(s))"
  if [ "$KEEP" = "0" ]; then
    emit "scratch root removed on exit"
  else
    emit "scratch root kept: $ROOT"
  fi
  exit 1
fi
emit "RESULT: PASS (all G1 probes and assertions passed; no real-home opens)"
if [ "$KEEP" = "0" ]; then
  emit "scratch root removed on exit"
else
  emit "scratch root kept: $ROOT"
fi
exit 0
