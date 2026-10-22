#!/bin/bash
# hermes_scratch.sh — run the hermes CLI only against a disposable scratch home.
#
# This is the single gateway for every hermes invocation made by the G1
# investigation.  It refuses to exec unless HERMES_HOME resolves to an absolute
# path inside a mktemp-created /tmp/g1-* directory, and it hard-refuses the real
# operator home (/home/kaladin/.hermes) even if that path is somehow nested
# under an allowed root.
#
# Usage:
#   HERMES_HOME=/tmp/g1-XXXX/hermes-home ./hermes_scratch.sh [hermes args...]
#
# Environment:
#   HERMES_HOME   required; absolute, existing directory under /tmp/g1-*
#   HERMES_BIN    optional; defaults to /home/kaladin/hermes-agent/venv/bin/hermes
#   TMPDIR        optional; scratch root (defaults to /tmp)
#
# The resolved command is printed to stderr before exec so every captured log
# records the exact interpreter and arguments used.
set -u

REAL_HOME="/home/kaladin/.hermes"
DEFAULT_HERMES_BIN="/home/kaladin/hermes-agent/venv/bin/hermes"
HERMES_BIN="${HERMES_BIN:-$DEFAULT_HERMES_BIN}"
SCRATCH_ROOT_RAW="${TMPDIR:-/tmp}"

refuse() {
  printf 'hermes_scratch: REFUSED: %s\n' "$1" >&2
  exit 64
}

[ -n "${HERMES_HOME:-}" ] || refuse "HERMES_HOME is not set"

case "$HERMES_HOME" in
  /*) ;;
  *) refuse "HERMES_HOME must be an absolute path (got: $HERMES_HOME)" ;;
esac

# Resolve symlinks and '..' before comparing: validation must inspect the real
# location the process would use, not the caller's spelling of it.
resolved_home="$(readlink -f -- "$HERMES_HOME" 2>/dev/null)" || refuse "cannot resolve HERMES_HOME=$HERMES_HOME"
[ -n "$resolved_home" ] || refuse "cannot resolve HERMES_HOME=$HERMES_HOME"

resolved_root="$(readlink -f -- "$SCRATCH_ROOT_RAW" 2>/dev/null)" || refuse "cannot resolve scratch root $SCRATCH_ROOT_RAW"
[ -n "$resolved_root" ] || resolved_root="$SCRATCH_ROOT_RAW"

# Hard guard: never the real operator home, and never anything under it.  This
# check runs before the /tmp/g1-* acceptance test so a symlink or a nested
# spelling can never reach the live stores.
case "$resolved_home" in
  "$REAL_HOME"|"$REAL_HOME"/*) refuse "HERMES_HOME resolves to the real operator home: $resolved_home" ;;
esac

# Scratch-only acceptance: a mktemp-created directory named /tmp/g1-* (or the
# same shape under an explicitly configured TMPDIR).
case "$resolved_home" in
  /tmp/g1-*|"$resolved_root"/g1-*) ;;
  *) refuse "HERMES_HOME must be under /tmp/g1-* (got: $resolved_home)" ;;
esac

[ -d "$resolved_home" ] || refuse "HERMES_HOME is not an existing directory: $resolved_home"

printf 'hermes_scratch: HERMES_HOME=%s\n' "$resolved_home" >&2
printf 'hermes_scratch: exec %s' "$HERMES_BIN" >&2
for arg in "$@"; do
  printf ' %q' "$arg" >&2
done
printf '\n' >&2

# Export the resolved path so hermes and every child process see the same home
# this wrapper validated.
HERMES_HOME="$resolved_home"
export HERMES_HOME

exec "$HERMES_BIN" "$@"
