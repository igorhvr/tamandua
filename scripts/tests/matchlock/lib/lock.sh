#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — shared real-VM gate lock, acquired at ONE layer.
#
# `lib/lock.sh` is a SOURCED library. Real-VM execution on the shared host runs
# under the coordinator's gate lock (default
# `/home/kaladin/matchlock-work/vaivm-gate.lock`, override `MTLK_GATE_LOCK`).
# The suite must never nest acquisitions: a composed invocation (e.g. the
# scheduled T4 spot-run that itself takes the lock) must be entered with the
# lock already held, and the inner layer must not take it again. Nested
# acquisition on the same lock file would self-deadlock, so the handshake is
# explicit:
#
#   * The OUTER caller takes the lock with `mtlk_gate_lock_acquire`, which sets
#     and EXPORTS `MTLK_GATE_LOCK_HELD=1` so every child inherits the marker.
#   * The INNER caller sees `MTLK_GATE_LOCK_HELD=1` and SKIPS acquisition
#     entirely (it does not open, flock or wait on the lock file), returning a
#     distinct "skipped" status.
#
# The lock is held on an open file descriptor for the lifetime of this process
# (the shell that sourced the library). The caller MUST release it with
# `mtlk_gate_lock_release` before exiting; if it forgets, the OS releases the
# flock when the process exits, so the lock can never leak across runs.
#
# Contract:
#   * `mtlk_gate_lock_acquire` blocks up to `MTLK_GATE_LOCK_WAIT` seconds
#     (default 3600) then fails closed with the exact line
#     `MTLK-GATE-LOCK-FAIL timeout:<lock>` and exit 6. It never proceeds
#     unlocked on timeout.
#   * A refusal from the `flock` tool (e.g. an unusable lock path) also fails
#     closed with `MTLK-GATE-LOCK-FAIL flock:<detail>` and exit 6.
#   * `flock` is required; a missing tool fails closed, never "runs anyway".
#
# Environment / bindings:
#   MTLK_GATE_LOCK        the lock file (from lib/common.sh; default vaimetal)
#   MTLK_GATE_LOCK_WAIT   bounded wait seconds (default 3600; never unbounded)
#   MTLK_GATE_LOCK_HELD   1 => the lock is already held by an outer layer
# =============================================================================

if [ "${MTLK_LOCK_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
MTLK_LOCK_SOURCED=1

# Source the shared configuration/bindings (idempotent). Deriving the path from
# BASH_SOURCE keeps the suite relocatable.
_mtlk_lock_self="${BASH_SOURCE[0]:-$0}"
_mtlk_lock_dir="$(cd -- "$(dirname -- "$_mtlk_lock_self")" && pwd)"
# shellcheck source=./common.sh
. "$_mtlk_lock_dir/common.sh"
unset _mtlk_lock_self _mtlk_lock_dir

# The fd number the lock is held on. A high, unusual fd keeps the LOCK fd out of
# the way of caller fds; it is opened in the caller's shell (this library is
# sourced), so all subsequent children inherit it.
MTLK_GATE_LOCK_FD="${MTLK_GATE_LOCK_FD:-9}"
# 1 => THIS shell layer opened the lock fd and must close it on release. An
# inner layer that merely inherited `MTLK_GATE_LOCK_HELD=1` never owns the fd
# and must not close the outer holder's descriptor.
MTLK_GATE_LOCK_OWNED="${MTLK_GATE_LOCK_OWNED:-0}"
export MTLK_GATE_LOCK MTLK_GATE_LOCK_FD

# mtlk_gate_lock_fail <reason> — exact refusal line + exit 6 (non-zero so a
# `... || ...` caller can also branch on the failure).
mtlk_gate_lock_fail() {
  printf 'MTLK-GATE-LOCK-FAIL %s\n' "$1" >&2
  exit 6
}

# mtlk_gate_lock_held — 0 when an outer layer already holds the lock.
mtlk_gate_lock_held() {
  [ "${MTLK_GATE_LOCK_HELD:-0}" = "1" ]
}

# mtlk_gate_lock_acquire — acquire the shared gate lock exactly once. Echoes
# `HELD <lock>` on this layer, `SKIP <lock>` when an outer layer holds it.
mtlk_gate_lock_acquire() {
  local lock="${MTLK_GATE_LOCK:-}" wait_s="${MTLK_GATE_LOCK_WAIT:-3600}"
  [ -n "$lock" ] || mtlk_gate_lock_fail "no-lock-path"

  if mtlk_gate_lock_held; then
    printf 'SKIP %s\n' "$lock"
    return 0
  fi
  # This shell layer already owns an open lock fd (but without the exported
  # handshake, e.g. a caller that unset it): treat as a skip, never flock again
  # on the same descriptor.
  if [ "${MTLK_GATE_LOCK_OWNED:-0}" = "1" ]; then
    printf 'SKIP %s\n' "$lock"
    return 0
  fi

  case "$wait_s" in
    '' | *[!0-9]*) mtlk_gate_lock_fail "bad-wait:$wait_s" ;;
  esac

  command -v flock >/dev/null 2>&1 || mtlk_gate_lock_fail "flock-missing"
  [ -d "$(dirname -- "$lock")" ] || mtlk_gate_lock_fail "lock-dir-missing:$(dirname -- "$lock")"

  local fd="$MTLK_GATE_LOCK_FD"
  eval "exec $fd>\"\$lock\"" 2>/dev/null ||
    mtlk_gate_lock_fail "cannot-open-lock:$lock"
  if ! eval "flock --exclusive -w \"\$wait_s\" $fd" 2>/dev/null; then
    eval "exec $fd>&-" 2>/dev/null || true
    mtlk_gate_lock_fail "timeout:$lock"
  fi

  MTLK_GATE_LOCK_OWNED=1
  MTLK_GATE_LOCK_HELD=1
  export MTLK_GATE_LOCK_HELD
  printf 'HELD %s\n' "$lock"
  return 0
}

# mtlk_gate_lock_release — release the lock (no-op when this layer did not take
# it). Safe to call unconditionally.
mtlk_gate_lock_release() {
  if [ "${MTLK_GATE_LOCK_OWNED:-0}" = "1" ]; then
    eval "exec $MTLK_GATE_LOCK_FD>&-" 2>/dev/null || true
    MTLK_GATE_LOCK_OWNED=0
    MTLK_GATE_LOCK_HELD=0
    export MTLK_GATE_LOCK_HELD
  fi
  return 0
}
