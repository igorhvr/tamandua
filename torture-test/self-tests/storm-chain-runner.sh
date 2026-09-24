#!/usr/bin/env bash
# storm-chain-runner.sh — O12-REPIN US-008 inner runner.
#
# Runs the 49-file storm self-test chain exactly as run #7 did: one
# `node --test` per file, serially, with the WHOLE chain under one held
# `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock` (the caller
# acquires the lock and invokes this script inside it).
#
# Every child runs under TAMANDUA_TEST_GUARD=1 with every harness binary pinned
# to /usr/bin/false. Every ambient TAMANDUA_* key is stripped from the child
# env so no production/control authority leaks in, and each child gets its own
# private TMPDIR.
#
# Env (set by the wrapper):
#   STORM_CHAIN_REPO          repo root the chain runs from
#   STORM_CHAIN_EVID          evidence dir
#   STORM_CHAIN_LOCK          lock path
#   STORM_CHAIN_SUBMIT_ISO    UTC ISO submit time (before the flock wait)
#   STORM_CHAIN_SUBMIT_EPOCH  seconds since epoch at submit
set -u

REPO="${STORM_CHAIN_REPO:?STORM_CHAIN_REPO is required}"
EVID="${STORM_CHAIN_EVID:?STORM_CHAIN_EVID is required}"
LOCK="${STORM_CHAIN_LOCK:-/home/kaladin/matchlock-work/vaivm-gate.lock}"
LIST="$EVID/chain-files.txt"
LOGDIR="$EVID/logs"

cd "$REPO" || { echo "cannot cd $REPO"; exit 90; }

# No ambient TAMANDUA_* authority: strip every ambient key, then pin the gate.
while IFS= read -r key; do
  [ -n "$key" ] && unset "$key"
done < <(env | sed -n 's/^\(TAMANDUA_[A-Za-z0-9_]*\)=.*/\1/p')

export TAMANDUA_TEST_GUARD=1
export TAMANDUA_PI_BINARY=/usr/bin/false
export TAMANDUA_HERMES_BINARY=/usr/bin/false
export TAMANDUA_DSH_BINARY=/usr/bin/false

mkdir -p "$EVID/tmp"
export TMPDIR="$EVID/tmp"

{
  echo "submit_iso=${STORM_CHAIN_SUBMIT_ISO}"
  echo "submit_epoch=${STORM_CHAIN_SUBMIT_EPOCH}"
  echo "acquire_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "acquire_epoch=${EPOCHREALTIME:-$(date +%s.%N)}"
  echo "lock=${LOCK}"
  echo "holder_pid=$$"
  echo "repo=${REPO}"
  echo "head=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "harness_guard_env=TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false"
} > "$EVID/meta-acquire.env"

: > "$EVID/results.tsv"
printf 'idx\tfile\trc\ttests\tpass\tfail\tskipped\tduration_ms\n' >> "$EVID/results.tsv"

idx=0
total_tests=0
total_pass=0
total_fail=0
total_skip=0
red_files=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  idx=$((idx + 1))
  base="$(basename "$f")"
  log="$LOGDIR/$(printf '%02d' "$idx")-$base.log"
  entry_tmp="$(mktemp -d "$EVID/tmp/entry.$(printf '%02d' "$idx").XXXXXX")"
  start_epoch="${EPOCHREALTIME:-$(date +%s.%N)}"
  TMPDIR="$entry_tmp" node --test "$f" > "$log" 2>&1
  rc=$?
  end_epoch="${EPOCHREALTIME:-$(date +%s.%N)}"
  dur_ms="$(awk -v a="$start_epoch" -v b="$end_epoch" 'BEGIN{printf "%.1f", (b-a)*1000}')"

  # node's reporters print "tests N" / "pass N" / "fail N" / "skipped N" with a
  # leading "ℹ" or "#". Take the LAST value of each.
  read -r tests pass fail skip < <(awk '
    $2=="tests"   {t=$3}
    $2=="pass"    {p=$3}
    $2=="fail"    {f=$3}
    $2=="skipped" {s=$3}
    END {printf "%d %d %d %d\n", t+0, p+0, f+0, s+0}
  ' "$log")

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$idx" "$f" "$rc" "$tests" "$pass" "$fail" "$skip" "$dur_ms" >> "$EVID/results.tsv"

  total_tests=$((total_tests + tests))
  total_pass=$((total_pass + pass))
  total_fail=$((total_fail + fail))
  total_skip=$((total_skip + skip))
  [ "$rc" -ne 0 ] && red_files=$((red_files + 1))

  echo "[$idx/49] rc=$rc tests=$tests pass=$pass fail=$fail skipped=$skip dur=${dur_ms}ms $f"
done < "$LIST"

{
  echo "release_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "release_epoch=${EPOCHREALTIME:-$(date +%s.%N)}"
  echo "total_files=$idx"
  echo "total_tests=$total_tests"
  echo "total_pass=$total_pass"
  echo "total_fail=$total_fail"
  echo "total_skipped=$total_skip"
  echo "red_files=$red_files"
} > "$EVID/meta-release.env"

if [ "$red_files" -eq 0 ] && [ "$idx" -eq 49 ]; then
  echo "STORM_CHAIN_RESULT: PASS ($idx files, tests=$total_tests pass=$total_pass fail=$total_fail skipped=$total_skip)"
  exit 0
fi
echo "STORM_CHAIN_RESULT: FAIL (files=$idx reds=$red_files tests=$total_tests fail=$total_fail)"
exit 1
