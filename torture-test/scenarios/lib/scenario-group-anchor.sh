#!/usr/bin/env bash
# SOGI identity-safe cleanup — disowned in-group identity anchor for
# run-scripted-scenario (torture-test/scenarios/lib/run-scripted-scenario).
#
# The scenario command runs as the leader of a DEDICATED process group
# (pgid == leader pid, its own session — see session-leader-spawn.mjs).
# When that leader fast-exits while a scenario-owned descendant still runs,
# the leader's start-time identity becomes unreadable, so a stale saved group
# id alone can no longer authorize a group signal. This anchor closes the gap
# with CURRENT evidence: it is spawned (disowned, through an intermediate
# subshell that exits at once, so the scenario command never sees it as a
# child and a bare `wait` cannot block on it) by the leader BEFORE release,
# publishes its own pid, and stays a member of the dedicated group. The
# harness records the anchor's pid and start time during the pre-release
# proof; cleanup re-reads that identity and group-signals only while the
# anchor is still alive with an unchanged start time (see
# group_identity_authorized / stop_owned_command in run-scripted-scenario).
#
# Lifecycle contract with the harness (argv: <anchor-pid-file> <release-file>
# [<abort-file>]):
#   1. Write $$ to <anchor-pid-file> immediately (the harness records it).
#   2. Wait (boundedly) for <release-file>; if the harness's explicit
#      <abort-file> appears first (pre-release proof failed), its invocation
#      dir disappears (the harness aborted and tore the cell down — SGBD
#      9.1.2 review hardening), or release never arrives (the harness died
#      before release), exit on our own — never leak and never hold inherited
#      pipe handles until a far cap.
#   3. Once released, ignore TERM (so the group identity stays re-provable
#      between the TERM and KILL cleanup rounds) and sleep for a bounded
#      lifetime; the harness's group KILL reaps us at cleanup.
# The self-terminating bounded lifetime is the safety valve for a harness
# that dies without running its cleanup (e.g. SIGKILL): the anchor — and
# therefore the held group id — disappears on its own instead of leaking.
#
# Bash 3.2 / macOS compatible by intent; zero tokens; confined to
# torture-test/.
set -u

pid_file="${1:-}"
release_file="${2:-}"
abort_file="${3:-}"
[ -n "$pid_file" ] && [ -n "$release_file" ] || exit 0

# Publish our pid first so the harness can record our identity pre-release.
printf '%s\n' "$$" >"$pid_file" 2>/dev/null || exit 0

# Bound the pre-release wait by the SAME self-expiration cap the session
# leader uses (TT_SCENARIO_UNRELEASED_TIMEOUT_S seconds, default 20 = the
# historical 400 x 0.05 s bound): the harness proves the group and releases
# within milliseconds on the happy path; if release never arrives the harness
# has failed before release and this process must not leak. The release file
# exists check mirrors the leader's own wait; the abort file check ends the
# wait promptly when the harness explicitly aborts an unreleased cell (SGBD
# 9.1.2 — the abort marker NEVER triggers scenario execution).
_unreleased_timeout_s="${TT_SCENARIO_UNRELEASED_TIMEOUT_S:-20}"
case "$_unreleased_timeout_s" in
  ""|*[!0-9]*) _unreleased_timeout_s=20 ;;
esac
# SGBD 9.1.2 review hardening (b): the abort marker lives in the harness's
# invocation dir, which its cleanup rm -rf's the instant the wait returns. An
# anchor descheduled past that removal would otherwise never observe the abort
# marker and would poll out its remaining cap — bounded and signal-free, but
# up to $_unreleased_timeout_s s of an orphaned process still holding
# inherited pipe handles. Pre-release the invocation dir must exist, so its
# disappearance means the harness aborted and tore the cell down: treat it
# exactly like the abort marker. (Post-release the loop below is already
# exited, so the normal cleanup rm -rf after the group KILL cannot abort a
# released anchor.)
_abort_dir=""
if [ -n "$abort_file" ]; then
  _abort_dir="$(dirname "$abort_file" 2>/dev/null || true)"
  # dirname(1) prints "." for a slash-less path and always succeeds in
  # practice; the empty-string fallback keeps the check conservative.
  if [ -z "$_abort_dir" ]; then _abort_dir="."; fi
fi
_release_seen=0
_i=0
_release_cap=$(( _unreleased_timeout_s * 20 ))
while [ "$_i" -lt "$_release_cap" ]; do
  if [ -e "$release_file" ]; then
    _release_seen=1
    break
  fi
  if [ -n "$abort_file" ] && { [ -e "$abort_file" ] || [ ! -d "$_abort_dir" ]; }; then
    break
  fi
  sleep 0.05
  _i=$(( _i + 1 ))
done
[ "$_release_seen" = "1" ] || exit 0

# TERM-immune from here: the cleanup TERM round must not destroy this
# identity evidence before the KILL escalation has been re-proven.
trap '' TERM

# Bounded lifetime (144 x 300 s = 12 h) in 5-minute rounds. The group KILL
# at cleanup normally reaps us long before this bound; the bound only caps
# the leak when cleanup can never run.
_round=0
while [ "$_round" -lt 144 ]; do
  sleep 300
  _round=$(( _round + 1 ))
done
exit 0
