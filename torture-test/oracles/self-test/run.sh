#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
TT_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd -P)
VAR_ROOT=${TT_SELF_TEST_VAR_ROOT:-"$TT_ROOT/var"}
SUITE_TIMEOUT_SECONDS=${TT_SELF_TEST_SUITE_TIMEOUT_SECONDS:-300}
ROUND_TIMEOUT_SECONDS=${TT_SELF_TEST_ROUND_TIMEOUT_SECONDS:-140}
COMMAND_TIMEOUT_SECONDS=${TT_SELF_TEST_COMMAND_TIMEOUT_SECONDS:-30}
O9_TIMEOUT_SECONDS=${TT_SELF_TEST_O9_TIMEOUT_SECONDS:-60}
GRACE_SECONDS=${TT_SELF_TEST_GRACE_SECONDS:-2}

require_positive_integer() {
  case "$2" in
    ''|*[!0-9]*|0)
      printf '%s must be a positive integer, got %s\n' "$1" "$2" >&2
      exit 2
      ;;
  esac
}

require_positive_integer TT_SELF_TEST_SUITE_TIMEOUT_SECONDS "$SUITE_TIMEOUT_SECONDS"
require_positive_integer TT_SELF_TEST_ROUND_TIMEOUT_SECONDS "$ROUND_TIMEOUT_SECONDS"
require_positive_integer TT_SELF_TEST_COMMAND_TIMEOUT_SECONDS "$COMMAND_TIMEOUT_SECONDS"
require_positive_integer TT_SELF_TEST_O9_TIMEOUT_SECONDS "$O9_TIMEOUT_SECONDS"
require_positive_integer TT_SELF_TEST_GRACE_SECONDS "$GRACE_SECONDS"

owned_pids() {
  local pid ppid rest needle changed index
  if [ "${TT_SELF_TEST_CLEAN_ROOT:-0}" = "1" ]; then
    [ -n "${TT_SELF_TEST_OWNERSHIP_ROOT:-}" ] || return 0
    needle="TT_SELF_TEST_OWNERSHIP_ROOT=$TT_SELF_TEST_OWNERSHIP_ROOT"
    while read -r pid rest; do
      [ "$pid" != "$$" ] || continue
      [ "$pid" != "$BASHPID" ] || continue
      case " $rest " in
        *" $needle "*) printf '%s\n' "$pid" ;;
      esac
    done < <(ps eww -U "$(id -u)" -o pid= -o args= 2>/dev/null)
    return 0
  fi

  local -a pids=() ppids=() commands=()
  local -A descendants=(["$$"]=1)
  while read -r pid ppid rest; do
    [ "$pid" != "$BASHPID" ] || continue
    pids+=("$pid")
    ppids+=("$ppid")
    commands+=("$rest")
  done < <(ps -U "$(id -u)" -o pid= -o ppid= -o args= 2>/dev/null)
  changed=1
  while [ "$changed" -eq 1 ]; do
    changed=0
    for index in "${!pids[@]}"; do
      pid=${pids[$index]}
      ppid=${ppids[$index]}
      [ -z "${descendants[$pid]:-}" ] || continue
      [ -n "${descendants[$ppid]:-}" ] || continue
      case "${commands[$index]}" in
        *"ps -U "*" -o pid= -o ppid= -o args="*) continue ;;
      esac
      descendants[$pid]=1
      printf '%s\n' "$pid"
      changed=1
    done
  done
}

pid_is_owned() {
  local pid=$1 needle details
  if [ "${TT_SELF_TEST_CLEAN_ROOT:-0}" = "1" ]; then
    needle="TT_SELF_TEST_OWNERSHIP_ROOT=${TT_SELF_TEST_OWNERSHIP_ROOT:-}"
  else
    needle="TT_SELF_TEST_INVOCATION_ID=${TT_SELF_TEST_INVOCATION_ID:-}"
  fi
  details=$(ps eww -p "$pid" -o args= 2>/dev/null) || return 1
  case " $details " in
    *" $needle "*) return 0 ;;
    *) return 1 ;;
  esac
}

process_group_is_owned() {
  local pid=$1 scope=$2 details pgid rest needle
  details=$(ps eww -p "$pid" -o pgid= -o args= 2>/dev/null) || return 1
  read -r pgid rest <<<"$details"
  [ "$pgid" = "$pid" ] || return 1
  needle="TT_SELF_TEST_INVOCATION_ID=$scope"
  case " $rest " in
    *" $needle "*) return 0 ;;
    *) return 1 ;;
  esac
}

signal_owned() {
  local signal=$1 pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    pid_is_owned "$pid" || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done < <(owned_pids)
}

owned_processes_exist() {
  [ -n "$(owned_pids)" ]
}

process_start_time() {
  local pid=$1 details rest
  local -a fields=()
  details=$(<"/proc/$pid/stat") || return 1
  rest=${details##*) }
  read -r -a fields <<<"$rest"
  [ "${#fields[@]}" -gt 19 ] || return 1
  printf '%s\n' "${fields[19]}"
}

process_is_ancestor() {
  local ancestor=$1 current=$BASHPID details rest
  local -a fields=()
  while [ "$current" -gt 1 ]; do
    details=$(<"/proc/$current/stat") || return 1
    rest=${details##*) }
    read -r -a fields <<<"$rest"
    [ "${#fields[@]}" -gt 1 ] || return 1
    current=${fields[1]}
    [ "$current" != "$ancestor" ] || return 0
  done
  return 1
}

watchdog_scope_is_valid() {
  local scope_file=${TT_SELF_TEST_WATCHDOG_SCOPE_FILE:-}
  local scope_token=${TT_SELF_TEST_WATCHDOG_SCOPE_TOKEN:-}
  local scope_fd=${TT_SELF_TEST_WATCHDOG_SCOPE_FD:-}
  local scope_owner_mode scope_dir scope_dir_owner_mode scope_identity fd_identity
  local supervisor_pid supervisor_start supervisor_current_start
  local -a scope_values=()
  local -a supervisor_argv=()

  [ "${TT_SELF_TEST_WATCHDOG_ACTIVE:-0}" = "1" ] || return 1
  [ -n "${TT_SELF_TEST_INVOCATION_ID:-}" ] || return 1
  [ -n "${TT_SELF_TEST_OWNERSHIP_ROOT:-}" ] || return 1
  [ -n "$scope_file" ] || return 1
  [ -n "$scope_token" ] || return 1
  case "$scope_fd" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ -f "$scope_file" ] || return 1
  [ ! -L "$scope_file" ] || return 1
  [ -e "/proc/$BASHPID/fd/$scope_fd" ] || return 1

  scope_dir=$(dirname -- "$scope_file")
  scope_owner_mode=$(stat -c '%u:%a' -- "$scope_file" 2>/dev/null) || return 1
  scope_dir_owner_mode=$(stat -c '%u:%a' -- "$scope_dir" 2>/dev/null) || return 1
  [ "$scope_owner_mode" = "$(id -u):600" ] || return 1
  [ "$scope_dir_owner_mode" = "$(id -u):700" ] || return 1
  scope_identity=$(stat -c '%d:%i' -- "$scope_file" 2>/dev/null) || return 1
  fd_identity=$(stat -Lc '%d:%i' -- "/proc/$BASHPID/fd/$scope_fd" 2>/dev/null) || return 1
  [ "$scope_identity" = "$fd_identity" ] || return 1

  mapfile -t scope_values <"$scope_file" || return 1
  [ "${#scope_values[@]}" -eq 4 ] || return 1
  [ "${scope_values[0]}" = "$TT_SELF_TEST_OWNERSHIP_ROOT" ] || return 1
  [ "${scope_values[1]}" = "$scope_token" ] || return 1
  supervisor_pid=${scope_values[2]}
  supervisor_start=${scope_values[3]}
  case "$supervisor_pid:$supervisor_start" in
    *[!0-9:]*) return 1 ;;
  esac
  process_is_ancestor "$supervisor_pid" || return 1
  supervisor_current_start=$(process_start_time "$supervisor_pid") || return 1
  [ "$supervisor_current_start" = "$supervisor_start" ] || return 1
  mapfile -d '' -t supervisor_argv <"/proc/$supervisor_pid/cmdline" || return 1
  [ "${#supervisor_argv[@]}" -ge 2 ] || return 1
  [ "${supervisor_argv[1]}" = "$0" ] || return 1
  case "${supervisor_argv[0]}" in
    bash|*/bash) ;;
    *) return 1 ;;
  esac
  case "$TT_SELF_TEST_INVOCATION_ID" in
    "$TT_SELF_TEST_OWNERSHIP_ROOT"|"$TT_SELF_TEST_OWNERSHIP_ROOT"-round-[1-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# The outermost process is deliberately outside the ownership token. It can
# therefore reap every token-bearing descendant, including a child that has
# escaped into a new session, without ever matching unrelated Tamandua work.
if ! watchdog_scope_is_valid; then
  # Never trust a caller-provided ownership token: cleanup authority must be
  # unique to this launch so concurrent self-tests cannot match one another.
  invocation_id="oracle-self-test-${BASHPID}-${RANDOM}-$(date +%s)"
  watchdog_dir=$(mktemp -d "${TMPDIR:-/tmp}/oracle-self-test-watchdog.XXXXXX")
  watchdog_scope_file="$watchdog_dir/scope"
  watchdog_scope_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  watchdog_supervisor_pid=$BASHPID
  watchdog_supervisor_start=$(process_start_time "$watchdog_supervisor_pid")
  printf '%s\n%s\n%s\n%s\n' \
    "$invocation_id" "$watchdog_scope_token" "$watchdog_supervisor_pid" "$watchdog_supervisor_start" \
    >"$watchdog_scope_file"
  chmod 600 -- "$watchdog_scope_file"
  exec {watchdog_scope_fd}<"$watchdog_scope_file"
  timed_out="$watchdog_dir/timed-out"
  watchdog_cancel="$watchdog_dir/cancel"
  mkfifo -m 600 -- "$watchdog_cancel"
  exec {watchdog_cancel_fd}<>"$watchdog_cancel"
  watchdog_channel_open=1
  child_pid=''
  watchdog_pid=''

  outer_cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [ -n "$child_pid" ] && process_group_is_owned "$child_pid" "$invocation_id"; then
      kill -TERM -- "-$child_pid" 2>/dev/null || true
    fi
    if TT_SELF_TEST_CLEAN_ROOT=1 TT_SELF_TEST_OWNERSHIP_ROOT=$invocation_id owned_processes_exist; then
      sleep "$GRACE_SECONDS"
    fi
    if [ -n "$child_pid" ] && process_group_is_owned "$child_pid" "$invocation_id"; then
      kill -KILL -- "-$child_pid" 2>/dev/null || true
    fi
    TT_SELF_TEST_CLEAN_ROOT=1 TT_SELF_TEST_OWNERSHIP_ROOT=$invocation_id signal_owned KILL
    if [ "$watchdog_channel_open" -eq 1 ]; then
      printf 'cancel\n' >&"$watchdog_cancel_fd" 2>/dev/null || true
      exec {watchdog_cancel_fd}>&-
      watchdog_channel_open=0
    fi
    exec {watchdog_scope_fd}>&-
    rm -rf -- "$watchdog_dir"
    exit "$status"
  }
  trap outer_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  TT_SELF_TEST_WATCHDOG_ACTIVE=1 \
  TT_SELF_TEST_WATCHDOG_SCOPE_FD=$watchdog_scope_fd \
  TT_SELF_TEST_WATCHDOG_SCOPE_FILE=$watchdog_scope_file \
  TT_SELF_TEST_WATCHDOG_SCOPE_TOKEN=$watchdog_scope_token \
  TT_SELF_TEST_INVOCATION_ID=$invocation_id \
  TT_SELF_TEST_OWNERSHIP_ROOT=$invocation_id \
    setsid --wait "$0" "$@" &
  child_pid=$!
  (
    if IFS= read -r -t "$SUITE_TIMEOUT_SECONDS" -u "$watchdog_cancel_fd"; then
      exit 0
    fi
    if process_group_is_owned "$child_pid" "$invocation_id"; then
      : >"$timed_out"
      kill -TERM -- "-$child_pid" 2>/dev/null || true
      sleep "$GRACE_SECONDS"
      # Give the child's TERM trap a bounded final window to reap descendants
      # and remove its workspace before the outer watchdog escalates.
      for _ in $(seq 1 20); do
        process_group_is_owned "$child_pid" "$invocation_id" || break
        sleep 0.05
      done
      if process_group_is_owned "$child_pid" "$invocation_id"; then
        kill -KILL -- "-$child_pid" 2>/dev/null || true
      fi
      TT_SELF_TEST_CLEAN_ROOT=1 TT_SELF_TEST_OWNERSHIP_ROOT=$invocation_id signal_owned KILL
    fi
  ) &
  watchdog_pid=$!

  if wait "$child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  printf 'cancel\n' >&"$watchdog_cancel_fd"
  wait "$watchdog_pid" 2>/dev/null || true
  did_timeout=0
  [ ! -e "$timed_out" ] || did_timeout=1
  watchdog_pid=''
  child_pid=''
  exec {watchdog_cancel_fd}>&-
  watchdog_channel_open=0
  exec {watchdog_scope_fd}>&-
  rm -rf -- "$watchdog_dir"
  if [ "$did_timeout" -eq 1 ]; then
    printf 'whole-suite watchdog expired after %ss\n' "$SUITE_TIMEOUT_SECONDS" >&2
    exit 124
  fi
  exit "$child_status"
fi

export TT_SELF_TEST_WATCHDOG_ACTIVE=1
export TT_SELF_TEST_WATCHDOG_SCOPE_FD
export TT_SELF_TEST_WATCHDOG_SCOPE_FILE
export TT_SELF_TEST_WATCHDOG_SCOPE_TOKEN
export TT_SELF_TEST_INVOCATION_ID
export TT_SELF_TEST_OWNERSHIP_ROOT
workspace=''
active_group=''

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$active_group" ] && process_group_is_owned "$active_group" "$TT_SELF_TEST_INVOCATION_ID"; then
    kill -TERM -- "-$active_group" 2>/dev/null || true
  fi
  signal_owned TERM
  if owned_processes_exist; then
    sleep "$GRACE_SECONDS"
  fi
  if [ -n "$active_group" ] && process_group_is_owned "$active_group" "$TT_SELF_TEST_INVOCATION_ID"; then
    kill -KILL -- "-$active_group" 2>/dev/null || true
  fi
  signal_owned KILL
  if [ -n "$workspace" ]; then
    case "$workspace" in
      "$VAR_ROOT"/oracle-self-test.*)
        if [ "${TT_SELF_TEST_KEEP_WORKSPACE:-0}" != "1" ]; then
          rm -rf -- "$workspace"
        fi
        ;;
      *)
        printf 'refusing to clean unexpected workspace: %s\n' "$workspace" >&2
        status=1
        ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_bounded() {
  local seconds=$1
  shift
  setsid --wait timeout --signal=TERM --kill-after="${GRACE_SECONDS}s" "${seconds}s" "$@" &
  active_group=$!
  local status
  if wait "$active_group"; then
    status=0
  else
    status=$?
  fi
  active_group=''
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf 'command watchdog expired after %ss: %q' "$seconds" "$1" >&2
    shift
    printf ' %q' "$@" >&2
    printf '\n' >&2
  fi
  return "$status"
}

if [ "${TT_SELF_TEST_SINGLE_ROUND:-0}" != "1" ]; then
  suite_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  for round in 1 2; do
    round_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    run_bounded "$ROUND_TIMEOUT_SECONDS" env \
      TT_SELF_TEST_SINGLE_ROUND=1 \
      TT_SELF_TEST_WATCHDOG_ACTIVE=1 \
      TT_SELF_TEST_INVOCATION_ID="$TT_SELF_TEST_OWNERSHIP_ROOT-round-$round" \
      TT_SELF_TEST_OWNERSHIP_ROOT="$TT_SELF_TEST_OWNERSHIP_ROOT" \
      "$0"
    round_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    printf 'self-test round %s PASS (%sms)\n' "$round" "$((round_finished_ms - round_started_ms))"
  done
  suite_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  printf 'self-test repeatability PASS (2 rounds, %sms total)\n' "$((suite_finished_ms - suite_started_ms))"
  exit 0
fi

mkdir -p -- "$VAR_ROOT"
workspace=$(mktemp -d "$VAR_ROOT/oracle-self-test.XXXXXX")

if [ "${TT_SELF_TEST_FAILURE_INJECTION:-}" = "hang" ]; then
  injection_pid_file=${TT_SELF_TEST_INJECTION_PID_FILE:-"$workspace/injected-descendant.pid"}
  setsid /bin/sh -c 'trap "" TERM; printf "%s\n" "$$" >"$1"; while :; do sleep 1; done' sh "$injection_pid_file" &
  wait
fi

run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o1-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o2-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o3z-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o8-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o9-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o10-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/generate-o11-fixtures.mjs" "$workspace"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/../calibration/generate-fixtures.mjs" "$workspace"
run_bounded "$O9_TIMEOUT_SECONDS" node --test --test-timeout=45000 "$TT_ROOT/bin/o9-mechanical-harvest.integration.test.mjs"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node --test --test-timeout=12000 "$SCRIPT_DIR/watchdog.test.mjs"
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-pass" --context "$workspace/evidence/pass/context.json" --expected PASS
run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-fail" --context "$workspace/evidence/fail/context.json" --expected FAIL

for fixture in "$workspace"/o1-*; do
  expected=$(run_bounded "$COMMAND_TIMEOUT_SECONDS" node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O1" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o2-*; do
  expected=$(run_bounded "$COMMAND_TIMEOUT_SECONDS" node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  if [ "$expected" = "ERROR" ]; then
    oracle_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    response_file="$fixture/oracle-response.json"
    set +e
    run_bounded "$COMMAND_TIMEOUT_SECONDS" "$SCRIPT_DIR/../O2" "$fixture/evidence/context.json" >"$response_file"
    oracle_status=$?
    set -e
    if [ "$oracle_status" -ne 2 ]; then
      printf 'expected ERROR but O2 exited %s for %s\n' "$oracle_status" "$fixture" >&2
      exit 1
    fi
    run_bounded "$COMMAND_TIMEOUT_SECONDS" node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.result!=="ERROR") process.exit(1)' "$response_file"
    oracle_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    oracle_elapsed_ms=$((oracle_finished_ms - oracle_started_ms))
    if [ "$oracle_elapsed_ms" -ge 10000 ]; then
      printf 'O2 ERROR fixture exceeded standalone 10-second limit (%sms)\n' "$oracle_elapsed_ms" >&2
      exit 1
    fi
    printf 'expected ERROR accepted for O2 (%sms)\n' "$oracle_elapsed_ms"
  else
    run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O2" --context "$fixture/evidence/context.json" --expected "$expected"
  fi
done

for oracle in O3z O8 O9 O10 O11; do
  prefix=$(printf '%s' "$oracle" | tr '[:upper:]' '[:lower:]')
  for fixture in "$workspace"/"$prefix"-*; do
    expected=$(run_bounded "$COMMAND_TIMEOUT_SECONDS" node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
    run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../$oracle" --context "$fixture/evidence/context.json" --expected "$expected"
  done
done

run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/../calibration/run.mjs" "$workspace"

if run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-false-positive" --context "$workspace/evidence/false-positive/context.json" --expected FAIL >/dev/null 2>&1; then
  printf 'self-test harness accepted a false positive\n' >&2
  exit 1
fi
printf 'false positive rejected\n'

if run_bounded "$COMMAND_TIMEOUT_SECONDS" node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-missed-violation" --context "$workspace/evidence/missed-violation/context.json" --expected PASS >/dev/null 2>&1; then
  printf 'self-test harness missed a violation\n' >&2
  exit 1
fi
printf 'missed violation rejected\n'
printf 'O1 terminal-state mutations PASS\n'
printf 'O2 merge-truth mutations PASS\n'
printf 'O3z token-gate mutations PASS\n'
printf 'O8 boundary-audit mutations PASS\n'
printf 'O9 ledger-replay mutations PASS\n'
printf 'O10 FMIS decision-table mutations PASS\n'
printf 'O11 output-contract/token-attribution mutations PASS\n'
printf 'O2/O9/O11 hard-case calibration pack PASS\n'
printf 'self-test harness PASS\n'
