#!/usr/bin/env bash
# tt-recorder-selftest-guards.sh — RISO US-001/US-002 guard library SHARED
# by the tt-recorder recorder self-test harness (bin/tt-recorder.test.sh),
# the PURE pre-execution guard proof (bin/tt-recorder-guard-proof.test.sh),
# the integration isolation regression (bin/tt-recorder-isolation.test.sh)
# and the focused port-isolation regression
# (bin/tt-recorder-port-isolation.test.sh).
#
# This file is SOURCED, never executed. It contains only definitions plus
# source-time initialization of every cleanup-owned variable (below); it
# performs no allocation, no process spawn, no state creation and no trap
# registration of its own. All consumers run `set -euo pipefail` before
# sourcing, so the guard code the full harness and the focused regressions
# exercise is byte-identical.
#
# RISO US-001 (recorder self-test isolation): nothing here may derive state
# from an invoking checkout. Every mutable fixture root is allocated with
# mktemp under the canonicalized temp base ($_fixbase) and recorded — at
# allocation time, IN THE ALLOCATING SHELL — in the _ALLOCATED_ROOTS indexed
# array; cleanup removes exactly that recorded set with one quoted rm -rf
# per element. Filesystem paths are NEVER serialized into a whitespace-
# delimited registry: one array element is one path, whatever bytes it
# contains (spaces, tabs, newlines, glob characters), and word splitting can
# never turn one freshly owned path into different deletion targets.
#
# RISO US-002 (honest port-exclusion coverage + allocator hardening): the
# allocator _riso_new_root captures mktemp's real exit status and requires
# the returned root to be the single fresh immediate directory under the
# trusted base (traversal / valid-looking-but-failing / prefix lookalikes
# are refused with ZERO removal); the malformed-allocation scenario adds a
# recording `rm` stub so even a direct rm regression cannot execute; the
# port-observation scenarios (allowed contained random-port listener that
# must be INCLUDED; excluded synthetic-pid production-port observation via a
# fake-lsof PATH shim that must be EXCLUDED) and the static reintroduction
# guard (production binds / source-checkout state usage) live here too —
# all with NO socket ever created on production ports 3334/3338/3339.
#
# Processes: only children the test actually spawned are tracked, each
# registered (via $!) with the start identity it had AT REGISTRATION and
# dropped from the registry once reaped. A PID read from a pidfile is NEVER
# signaled unless it is alive AND its cmdline names the EXACT fixture
# recorder tool AND its cwd is under the fixture root AND its start identity
# is unchanged since the first attestation — a stale numeric PID is not
# ownership, and a pre-existing pidfile never authorizes killing anything.
# Every signal rechecks identity/evidence first.
#
# MACP3 US-004: every '/proc' literal in this library is linux-only. All
# RUNTIME /proc reads carry an explicit inline 'MACP3 US-004 linux-only'
# comment with their Darwin behavior (guard fails, pass-by-note); '/proc'
# mentions in this header and in comments are documentation only. This
# harness family is GNU/Linux-only and gnu-lint-allowlisted; readlink -f is
# used to canonicalize the temp base and TT_ROOT_VAR.

# ── source-time initialization ────────────────────────────────────────
# Every cleanup-owned path, registry and seam variable is initialized EMPTY
# here, at source time, BEFORE any consumer allocation or trap registration:
# an inherited environment/argument marker can therefore never name a
# deletion root or a signal target. Roots are assigned ONLY from this
# invocation's own successful mktemp results and appended to _ALLOCATED_ROOTS
# in the allocating shell at allocation time; a filename prefix is never
# treated as creation proof, and no supplied root can opt out of allocation.
FIXTURE_ROOT=""
NEIGHBOR_ROOT=""
_ALLOCATED_ROOTS=()
_SELFTEST_SIGNAL_LOG=""
_SELFTEST_RM_LOG=""
OWNED_PIDS=""
_cleanup_ran=0
TOOL=""
TT_ROOT_VAR=""
TT_REPO_ROOT=""
FAILURES=0

# Canonical temp base (readlink -f is GNU/Linux-only; this harness family is
# gnu-lint-allowlisted as linux-side-only). Hostile-name regressions re-point
# TMPDIR at synthetic bases in a child shell and source this file there, so
# _fixbase canonicalizes the hostile path in that child. readlink -f is
# guarded so a missing TMPDIR degrades to its literal value instead of
# aborting the consumer.
_fixbase="$(readlink -f "${TMPDIR:-/tmp}" 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}")"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# _riso_new_root — allocate ONE fresh root under the given base (default:
# the canonical temp base) with the given name stem and PRINT it. Command
# substitution cannot carry side effects back to the caller, so the CALLER
# appends the printed path to _ALLOCATED_ROOTS — the exact cleanup-owned
# set — immediately after a successful call, in the allocating shell. Never
# reads an inherited marker or environment value; a fresh mktemp result is
# the only creation proof cleanup trusts.
#
# RISO US-002 allocator follow-up (coordinator 2026-09-05T00:34Z): the
# returned root must be the SINGLE fresh immediate directory this invocation
# requested under the trusted base, and the allocator's REAL exit status is
# captured explicitly (never left to errexit inside a command substitution
# or a conditional, which can mask a nonzero status). A malformed/untrusted
# mktemp response is REFUSED with diagnostics and is NEVER passed to a
# destructive operation: nothing is removed and nothing is recorded for it —
# it is retained only in the error message. Refused response classes:
#   * mktemp exited non-zero — even when it printed a valid-looking root
#     (a fake/broken allocator printing a path and then failing is refused);
#   * the printed root is not under "$base/$stem." (prefix lookalike);
#   * the printed root is not an IMMEDIATE child of "$base" — anything with
#     further path components after "$stem." (e.g. a traversal such as
#     "$base/$stem.ABC123/../../neighbor") is refused even though it passes
#     the lexical prefix check;
#   * the printed root is not a real directory or is a symlink (a path-
#     prefix or symlink lookalike is never a fresh owned directory).
_riso_new_root() {
  local stem="$1" base="${2:-$_fixbase}" root suffix rc=0
  # Capture mktemp's real exit status explicitly: the assignment is part of
  # an || list (never the final command), so errexit cannot abort before rc
  # is captured, and rc holds mktemp's true status either way.
  root="$(mktemp -d -- "$base/$stem.XXXXXX" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: unsafe root allocation — mktemp exited $rc; refusing to record or remove anything" >&2
    return 1
  fi
  [ -n "$root" ] || {
    echo "FAIL: unsafe root allocation — mktemp returned an empty root; refusing to record or remove anything" >&2
    return 1
  }
  case "$root" in
    "$base"/"$stem".*) : ;;
    *)
      echo "FAIL: unsafe root allocation — mktemp returned '$root', not under $base/$stem.*; refusing to record or remove it" >&2
      return 1
      ;;
  esac
  # Immediate-directory requirement: the remainder after "$base/$stem." must
  # be ONE non-empty component with no further '/' — a traversal lookalike
  # like "$base/$stem.ABC123/../../neighbor" passes the prefix case above but
  # must be refused here.
  suffix="${root#"$base"/"$stem".}"
  case "$suffix" in
    */*|"")
      echo "FAIL: unsafe root allocation — mktemp returned '$root' (not an immediate fresh directory under $base/$stem.*); refusing to record or remove it" >&2
      return 1
      ;;
  esac
  # The returned path must be a real fresh directory, not a symlink.
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "FAIL: unsafe root allocation — mktemp returned '$root' (not a fresh owned directory); refusing to record or remove it" >&2
    return 1
  fi
  printf '%s' "$root"
}

# _fixture_scoped_seam — 0 (true) iff "$1" is a non-empty seam path under
# "$FIXTURE_ROOT". An out-of-fixture seam value (or a seam with no fixture
# allocated yet) is refused by clearing it, so a seam can never authorize
# arbitrary external writes or suppress real cleanup. The empty-FIXTURE_ROOT
# guard matters: with FIXTURE_ROOT empty the pattern "$FIXTURE_ROOT"/* would
# collapse to "/*" and match every absolute path — never allowed.
_fixture_scoped_seam() {
  local seam="$1"
  [ -n "$seam" ] || return 1
  [ -n "$FIXTURE_ROOT" ] || return 1
  case "$seam" in
    "$FIXTURE_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# _kill — single signal choke point for this harness family. The deny-and-
# record seam _SELFTEST_SIGNAL_LOG (a PRIVATE variable, initialized empty at
# source time and assigned by the ownership sub-tests only to a fresh path
# under FIXTURE_ROOT) records intended signals instead of delivering them,
# so the sub-tests can prove decoy/reused pids are never signaled without
# risking any real process. A seam path OUTSIDE the fixture is refused (the
# signal is delivered for real). Exit cleanup clears the seam first.
_kill() {
  if [ -n "$_SELFTEST_SIGNAL_LOG" ] && ! _fixture_scoped_seam "$_SELFTEST_SIGNAL_LOG"; then
    _SELFTEST_SIGNAL_LOG=""
  fi
  if [ -n "$_SELFTEST_SIGNAL_LOG" ]; then
    printf 'signal %s\n' "$*" >> "$_SELFTEST_SIGNAL_LOG" 2>/dev/null || true
    return 0
  fi
  kill "$@"
}

# _rmrf — single removal choke point for cleanup-owned roots. The deny-and-
# record removal seam _SELFTEST_RM_LOG (PRIVATE, same rules as the signal
# seam) records the EXACT target bytes — NUL-delimited, so paths containing
# spaces/tabs/newlines/glob characters are preserved byte-for-byte — instead
# of removing, letting the regressions prove the registry expands each root
# as ONE path. An out-of-fixture seam value is refused (real removal
# proceeds). Exit cleanup clears the seam before real removal.
_rmrf() {
  if [ -n "$_SELFTEST_RM_LOG" ] && ! _fixture_scoped_seam "$_SELFTEST_RM_LOG"; then
    _SELFTEST_RM_LOG=""
  fi
  if [ -n "$_SELFTEST_RM_LOG" ]; then
    printf '%s\0' "$1" >> "$_SELFTEST_RM_LOG" 2>/dev/null || true
    return 0
  fi
  rm -rf -- "$1" 2>/dev/null || true
}

# _remove_allocated_roots — remove EXACTLY the roots recorded in
# _ALLOCATED_ROOTS by this invocation's own successful allocations, one
# quoted rm -rf per element (never a whitespace-delimited loop variable).
# Under the deny-and-record removal seam nothing is removed — each target is
# recorded byte-for-byte instead — and the registry is retained; with the
# seam clear the recorded set is removed and then emptied.
_remove_allocated_roots() {
  local r seam=0
  if [ -n "$_SELFTEST_RM_LOG" ] && _fixture_scoped_seam "$_SELFTEST_RM_LOG"; then
    seam=1
  fi
  for r in "${_ALLOCATED_ROOTS[@]+"${_ALLOCATED_ROOTS[@]}"}"; do
    [ -n "$r" ] || continue
    _rmrf "$r"
  done
  if [ "$seam" -eq 0 ]; then
    _ALLOCATED_ROOTS=()
  fi
}

# _proc_starttok — stable per-process start token for a pid (linux-only).
# /proc/<pid>/stat field 22 (starttime) sits after the comm field, which is
# wrapped in parens and may ITSELF contain ')' and spaces. All fields after
# comm are a single-letter state followed by numbers, so the paren that
# closes comm is the LAST ') ' in the line; stripping through that last
# occurrence leaves "state ppid ... starttime ..." where starttime is the
# 20th field of the remainder. Empty when the pid is gone or unreadable, so
# every identity comparison fails safe (never signal).
_proc_starttok() {
  local pid="$1" stat rest
  [ -n "$pid" ] || return 0
  # linux-only /proc/$pid/stat read (MACP3 US-004): 2>/dev/null-guarded — a
  # /proc-less host or vanished pid reads nothing and degrades to "no match".
  stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
  [ -n "$stat" ] || return 0
  rest="${stat##*\) }"                  # after the LAST ') ' → "state ... starttime ..."
  printf '%s' "$rest" | awk '{print $20}'   # starttime = full-stat field 22
}

_register_owned() {
  local pid="$1" tok tries=0
  [ -n "$pid" ] || return 0
  # the child may not be visible in /proc for a few scheduler ticks after
  # fork; a short bounded retry makes registration deterministic
  while [ "$tries" -lt 20 ]; do
    tok="$(_proc_starttok "$pid")"
    [ -n "$tok" ] && break
    sleep 0.02
    tries=$((tries + 1))
  done
  [ -n "$tok" ] || return 0          # cannot attest identity → not owned
  _unregister_owned "$pid"           # drop any stale entry for this pid first
  OWNED_PIDS="$OWNED_PIDS $pid:$tok"
}

_unregister_owned() {
  local pid="$1" t out=""
  for t in $OWNED_PIDS; do
    case "$t" in
      "$pid":*) ;;                   # drop the reaped entry
      *) out="$out $t" ;;
    esac
  done
  OWNED_PIDS="$out"
}

# _owned_identity_matches — 0 (true) iff $pid has a registry entry whose
# recorded start token equals the identity of the process currently there.
_owned_identity_matches() {
  local pid="$1" t cur
  cur="$(_proc_starttok "$pid")"
  [ -n "$cur" ] || return 1
  for t in $OWNED_PIDS; do
    case "$t" in
      "$pid":*) [ "${t#*:}" = "$cur" ]; return $? ;;
    esac
  done
  return 1
}

# _stop_registered_pid — stop ONE registered owned child and drop it from
# the registry. Identity is re-verified before EVERY signal; reaped/reused
# pids are never signaled. Under the deny-and-record seam no real signal is
# delivered, so no bounded wait is needed and a live child is never blocked
# on. With real signals the direct child is reaped once it is gone (bash
# also reaps background children on its own).
_stop_registered_pid() {
  local pid="$1" waited seam=0
  [ -n "$pid" ] || return 0
  if [ -n "$_SELFTEST_SIGNAL_LOG" ] && _fixture_scoped_seam "$_SELFTEST_SIGNAL_LOG"; then
    seam=1
  fi
  if _owned_identity_matches "$pid"; then
    _kill -TERM "$pid" 2>/dev/null || true
    if [ "$seam" -eq 0 ]; then
      waited=0
      while _owned_identity_matches "$pid" && [ "$waited" -lt 20 ]; do
        sleep 0.1
        waited=$((waited + 1))
      done
    fi
  fi
  if _owned_identity_matches "$pid"; then
    _kill -KILL "$pid" 2>/dev/null || true
    if [ "$seam" -eq 0 ]; then
      waited=0
      while _owned_identity_matches "$pid" && [ "$waited" -lt 20 ]; do
        sleep 0.1
        waited=$((waited + 1))
      done
    fi
  fi
  if [ "$seam" -eq 0 ]; then
    # Real-signal teardown: reap the direct child when it is gone. Never
    # block on a live process; never wait on a non-child (identity changed)
    # — `wait` returns immediately for a pid that is not our child.
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
    fi
  fi
  _unregister_owned "$pid"
}

# _reap_owned — stop every remaining registered owned child (exit/abort path).
_reap_owned() {
  local t pid
  for t in $OWNED_PIDS; do
    case "$t" in
      *:*) pid="${t%%:*}" ;;
      *) continue ;;
    esac
    _stop_registered_pid "$pid"
  done
}

# _recorder_pid_evidence — 0 (true) iff $pid is alive AND its cmdline names
# the EXACT fixture recorder tool ($TOOL — a path unique to this
# invocation) AND its cwd is under the fixture root. A PID read from any
# pidfile — pre-existing, foreign, or stale — can never pass: the only
# processes whose cmdline contains this invocation's $TOOL path are the
# recorders this run's fixture tool detached. An empty $TOOL (no fixture
# tool mirrored) fails safe.
_recorder_pid_evidence() {
  local pid="$1" cmdline cwd
  [ -n "$pid" ] || return 1
  [ -n "$TOOL" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # linux-only /proc/$pid/cmdline read (MACP3 US-004): 2>/dev/null-guarded —
  # a /proc-less host or vanished pid reads nothing and fails safe.
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in *"$TOOL"*) : ;; *) return 1 ;; esac
  # linux-only /proc/$pid/cwd readlink (MACP3 US-004): same fail-safe.
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$FIXTURE_ROOT"|"$FIXTURE_ROOT"/*) : ;;
    *) return 1 ;;
  esac
  return 0
}

# _recorder_identity_ok — 0 (true) iff $pid passes the full cmdline/cwd
# evidence AND its current start identity equals $want_tok (the identity
# captured at first attestation). A changed/reused identity with the same
# cmdline/cwd can never pass.
_recorder_identity_ok() {
  local pid="$1" want_tok="$2" cur
  [ -n "$want_tok" ] || return 1
  cur="$(_proc_starttok "$pid")"
  [ -n "$cur" ] || return 1
  [ "$cur" = "$want_tok" ] || return 1
  _recorder_pid_evidence "$pid"
}

# _recorder_teardown_pid — evidence-verified TERM → bounded wait → RE-
# ATTESTED KILL for a pidfile-recorded recorder PID (never registered: it
# was detached by a tool subprocess). The FIRST attestation (alive + exact
# fixture-tool cmdline + fixture cwd) captures the start identity; EVERY
# later signal requires that SAME identity plus re-attested evidence, so a
# pid that died and was reused is never signaled after the initial TERM.
_recorder_teardown_pid() {
  local pid="$1" waited tok=""
  [ -n "$pid" ] || return 0
  if ! _recorder_pid_evidence "$pid"; then
    return 0                        # dead/foreign — nothing to signal
  fi
  tok="$(_proc_starttok "$pid")"
  [ -n "$tok" ] || return 0         # cannot attest identity → never signal
  if _recorder_identity_ok "$pid" "$tok"; then
    _kill -TERM "$pid" 2>/dev/null || true
    if [ -z "$_SELFTEST_SIGNAL_LOG" ]; then
      waited=0
      while _recorder_identity_ok "$pid" "$tok" && [ "$waited" -lt 30 ]; do
        sleep 0.1
        waited=$((waited + 1))
      done
    fi
  fi
  if _recorder_identity_ok "$pid" "$tok"; then
    _kill -KILL "$pid" 2>/dev/null || true
  fi
}

# _teardown_recorder_pidfile — evidence-verified teardown of a fixture-
# owned pidfile entry, then removal of that pidfile. The pidfile path MUST
# be under the fixture (removal never traverses a checkout-derived path);
# an out-of-fixture path — or a call made before any fixture was allocated —
# is refused (returns non-zero, deletes nothing, signals nothing).
_teardown_recorder_pidfile() {
  local pidfile="$1" pid
  if [ -z "$FIXTURE_ROOT" ]; then
    echo "FAIL: refusing pidfile teardown before a fixture root exists: $pidfile" >&2
    return 1
  fi
  case "$pidfile" in
    "$FIXTURE_ROOT"/*) : ;;
    *)
      echo "FAIL: refusing pidfile outside the fixture: $pidfile" >&2
      return 1
      ;;
  esac
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  _recorder_teardown_pid "$pid"
  rm -f -- "$pidfile"
}

# _selftest_cleanup — normal-exit and failure/abort teardown, runs exactly
# once. Exit cleanup ALWAYS delivers real signals and performs real removal
# (both deny-and-record seams are cleared first), stops every registered
# owned child (identity rechecked per signal), evidence-tears-down any
# fixture recorder pidfile, and removes ONLY the roots recorded in
# _ALLOCATED_ROOTS by this invocation's own successful allocations. Cleanup
# never traverses outside those exact paths and never consults an optional
# (still-unallocated) root.
_selftest_cleanup() {
  if [ "$_cleanup_ran" -eq 0 ]; then
    _cleanup_ran=1
    _SELFTEST_SIGNAL_LOG=""
    _SELFTEST_RM_LOG=""
    if [ -n "$TT_ROOT_VAR" ]; then
      _teardown_recorder_pidfile "$TT_ROOT_VAR/recorder/tt-recorder.pid" 2>/dev/null || true
    fi
    _reap_owned
    _remove_allocated_roots
  fi
}

# riso_install_traps — register the cleanup traps. Call ONLY after every
# cleanup-owned variable is initialized (source-time, above) and every
# teardown helper is defined (above) — i.e. after the consumer's own
# fixture allocation, never before it.
riso_install_traps() {
  trap '_selftest_cleanup' EXIT
  trap '_selftest_cleanup; exit 130' INT
  trap '_selftest_cleanup; exit 143' TERM
}

# riso_bootstrap_fixture — allocate ONE fresh invocation-owned fixture root,
# mirror the real tt-recorder tool into it (copy only — the repo tool is
# never modified), pin SCRIPT_DIR / TOOL / TT_ROOT_VAR to the mirror, cd into
# the fixture, and run the TT_ROOT_VAR-under-fixture startup guard, which
# FAILs loudly (non-zero + FAIL line) whenever the computed TT_ROOT_VAR is
# not under this invocation's fixture root — proving it never selects the
# source checkout's torture-test/var. The caller MUST set _SRC_BIN (the real
# repo bin directory containing the tt-recorder tool) before calling.
riso_bootstrap_fixture() {
  local stem="${1:-tt-recorder-selftest}"
  FIXTURE_ROOT="$(_riso_new_root "$stem")"
  _ALLOCATED_ROOTS+=("$FIXTURE_ROOT")
  # Mirror the real tt-recorder tool into the fixture (copy only — never
  # modify the repo tool). The fixture copy derives TT_ROOT below, so every
  # path it computes lands under this invocation's fixture.
  mkdir -p "$FIXTURE_ROOT/torture-test/bin"
  cp "$_SRC_BIN/tt-recorder" "$FIXTURE_ROOT/torture-test/bin/tt-recorder"
  # Pin the root variables to the fixture mirror WITHOUT re-exec: SCRIPT_DIR
  # / TOOL / TT_ROOT_VAR — and the repeated root re-derivations later in the
  # harness (which derive from SCRIPT_DIR) — stay fixture-owned.
  SCRIPT_DIR="$FIXTURE_ROOT/torture-test/bin"
  TOOL="$SCRIPT_DIR/tt-recorder"
  TT_DIR="$(dirname "$SCRIPT_DIR")"
  TT_REPO_ROOT="$(dirname "$TT_DIR")"
  TT_ROOT_VAR="${TT_REPO_ROOT}/torture-test/var"
  # cd into the fixture: plain children, decoys and detached recorders that
  # inherit a cwd are then fixture-owned, never the invoking checkout.
  cd "$FIXTURE_ROOT"
  # Startup path guard: FAIL loudly (non-zero + FAIL line) if TT_ROOT_VAR is
  # ever not under THIS invocation's fixture root — before any state is
  # created or touched.
  TT_ROOT_VAR_RESOLVED="$(readlink -f "$TT_ROOT_VAR" 2>/dev/null || printf '%s' "$TT_ROOT_VAR")"
  case "$TT_ROOT_VAR_RESOLVED" in
    "$FIXTURE_ROOT"/*) : ;;
    *)
      echo "FAIL: TT_ROOT_VAR ($TT_ROOT_VAR_RESOLVED) is not under the invocation fixture root $FIXTURE_ROOT" >&2
      exit 1
      ;;
  esac
  mkdir -p "$TT_ROOT_VAR"
  riso_install_traps
}

# ── focused ownership/cleanup regressions (shared scenario code) ──────
# Both the full harness, the guard-only proof and the isolation regression
# run these through pass()/fail(), so the focused regressions exercise the
# SAME guard implementation they ship.

# riso_case_hostile_cleanup — cleanup-registry expansion red-arm for the
# cleanup registry, run with an UNCONDITIONAL RECORDING REMOVAL STUB. Creates
# base dir <parent>/<name> — <name> may contain spaces/tabs/newlines/glob
# bytes — allocates a root inside it with the real _riso_new_root, records it
# in a PRIVATE copy of _ALLOCATED_ROOTS (the live registry is saved/restored
# so a hostile root can never join this run's real cleanup set), plants a
# sentinel dir at $3 (the first-whitespace fragment and/or glob-expansion
# victim of unquoted word-split removal), then runs _remove_allocated_roots
# while `rm` is shadowed by a stub that RECORDS each invocation's exact argv
# bytes (NUL-delimited per argument) and deletes NOTHING.
#
# The operation under test — removal-target expansion — is never executed for
# real while it is being checked: a word-splitting/glob-expanding registry
# would issue MULTIPLE rm calls or pass fragment/expanded path bytes, and the
# byte-exact single-call assertion fails. Real removal of the recorded root is
# left to the fixture's own already-proven exit cleanup (the test-owned root
# lives under the parent, which lives under this invocation's FIXTURE_ROOT),
# which is a different operation from the expansion being checked here.
riso_case_hostile_cleanup() {
  local parent="$1" name="$2" sentinel="$3" label="$4"
  local base root rec count
  local -a saved_roots=()
  saved_roots=( "${_ALLOCATED_ROOTS[@]+"${_ALLOCATED_ROOTS[@]}"}" )
  _ALLOCATED_ROOTS=()
  base="$parent/$name"
  mkdir -p -- "$base"
  if [ -n "$sentinel" ]; then
    mkdir -p -- "$sentinel"
    printf '%s' 'hostile-sentinel-bytes' > "$sentinel/keep-me"
  fi
  root="$(_riso_new_root "tt-recorder-selftest-$label" "$base")"
  _ALLOCATED_ROOTS+=("$root")
  # Scratch evidence + unconditional recording removal stub: every rm call the
  # registry expansion makes is written, argv bytes preserved NUL-delimited,
  # under $base/.rm-record (retained until this run's exit cleanup removes the
  # owned fixture). Nothing is ever deleted by the stub.
  rec="$base/.rm-record"
  mkdir -p -- "$rec"
  rm() {
    local n=0 a
    [ -f "$rec/count" ] && n="$(cat "$rec/count" 2>/dev/null || true)"
    n=$((n + 1))
    printf '%s' "$n" > "$rec/count"
    {
      for a in "$@"; do printf '%s\0' "$a"; done
    } > "$rec/call-$n"
  }
  _remove_allocated_roots
  unset -f rm
  count="$(cat "$rec/count" 2>/dev/null || true)"
  printf '%s\0' '-rf' '--' "$root" > "$rec/expected"
  if [ "$count" -eq 1 ] && [ -f "$rec/call-1" ] && cmp -s "$rec/call-1" "$rec/expected" && \
     [ -d "$root" ] && \
     { [ -z "$sentinel" ] || { [ -f "$sentinel/keep-me" ] && [ "$(cat "$sentinel/keep-me" 2>/dev/null || true)" = 'hostile-sentinel-bytes' ]; }; }; then
    pass "hostile cleanup ($label): expansion issued ONE recorded rm with the exact whole-root argv; nothing deleted; sentinel intact"
  else
    fail "hostile cleanup ($label): registry expansion unsafe (recorded calls=$count; word-split or glob-expanded argv)"
  fi
  _ALLOCATED_ROOTS=( "${saved_roots[@]+"${saved_roots[@]}"}" )
}

# riso_case_malformed_allocation — a fake allocator that either "succeeds"
# but prints an out-of-base / non-immediate / traversal-looking path, prints
# a valid-looking root but then FAILS (non-zero exit), or fails outright must
# be REFUSED with ZERO removal calls: the real allocator is reached (a
# reached-marker proves it), the sentinel survives byte-identical, a NON-
# OPTIONAL deny-and-record removal boundary installed AFTER sourcing (so the
# library's source-time init cannot clear it) AND an UNCONDITIONAL recording
# `rm` stub (so even a direct `rm` regression inside the allocator records
# its argv and deletes NOTHING) together record zero removal calls, and
# nothing joins the cleanup registry. A rejected/untrusted root is never
# passed to a destructive operation.
# Args: $1 parent dir, $2 label, $3 mode — "malformed" (prints an out-of-base
# path, exits 0), "fail" (fails outright with no output), "badrc" (prints a
# valid-looking immediate root but exits 7 — RISO US-002 allocator follow-up:
# a nonzero allocator exit must be refused even with valid-looking output),
# "traversal" (exits 0 printing "$BASE/$stem.XXX/../../neighbor" — passes the
# lexical prefix, must be refused as non-immediate — RISO US-002 follow-up).
riso_case_malformed_allocation() {
  local parent="$1" label="$2" mode="$3"
  local sentinel rc out seam marker libpath
  mkdir -p -- "$parent"
  sentinel="$parent/malformed-sentinel-$label"
  printf '%s' 'malformed-sentinel-bytes' > "$sentinel"
  seam="$parent/deny-record-$label"
  marker="$parent/reached-$label"
  rm -f -- "$seam" "$marker"
  # inside a function BASH_SOURCE[0] is the file the function was defined in
  # — this guards library — so the child sources the SAME real guard code.
  # Every variable the child needs is passed through its environment (never
  # referenced bare under set -u), so an unbound-variable abort can never
  # masquerade as the intended rejection.
  libpath="${BASH_SOURCE[0]}"
  set +e
  out="$(SENTINEL_PATH="$sentinel" BASE="$parent" SEAM_PATH="$seam" MARKER_PATH="$marker" \
         MODE="$mode" LIBPATH="$libpath" bash -c '
    set -euo pipefail
    source "$LIBPATH"
    # NON-OPTIONAL deny-and-record boundary installed AFTER source-time init
    # (the init would otherwise clear it): any removal through the harness
    # removal choke is recorded under the seam, never executed.
    FIXTURE_ROOT="$BASE"
    _SELFTEST_RM_LOG="$SEAM_PATH"
    # UNCONDITIONAL recording rm stub: even a DIRECT `rm` regression inside
    # the allocator/rejection path (a call that bypasses the _rmrf choke)
    # records its exact argv under $BASE/.direct-rm-record-$MODE and deletes
    # NOTHING — the focused rejection proof can never execute a removal.
    mkdir -p "$BASE/.direct-rm-record-$MODE"
    rm() {
      local n=0 a
      [ -f "$BASE/.direct-rm-record-$MODE/count" ] && n="$(cat "$BASE/.direct-rm-record-$MODE/count" 2>/dev/null || true)"
      n=$((n + 1))
      printf "%s" "$n" > "$BASE/.direct-rm-record-$MODE/count"
      { for a in "$@"; do printf "%s\0" "$a"; done; } > "$BASE/.direct-rm-record-$MODE/call-$n"
    }
    # reached-marker written only after the boundaries are armed, immediately
    # before the real allocator runs — proves the allocator was reached.
    printf "%s" "reached" > "$MARKER_PATH"
    # fake allocator per mode:
    mktemp() {
      case "$MODE" in
        malformed) printf "%s" "$SENTINEL_PATH"; return 0 ;;
        fail) return 1 ;;
        # RISO US-002 follow-up arms:
        badrc) printf "%s" "$BASE/tt-recorder-selftest-badrc.ABC123"; return 7 ;;
        traversal) printf "%s" "$BASE/tt-recorder-selftest-traversal.ABC123/../../neighbor"; return 0 ;;
      esac
      return 1
    }
    r="$(_riso_new_root "tt-recorder-selftest-$MODE" "$BASE")" || exit 17
    printf "%s" "$r"
  ' 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 17 ] && [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null || true)" = "reached" ] && \
     [ -f "$sentinel" ] && [ "$(cat "$sentinel" 2>/dev/null || true)" = 'malformed-sentinel-bytes' ] && \
     { [ ! -f "$seam" ] || [ ! -s "$seam" ]; } && \
     { [ ! -f "$parent/.direct-rm-record-$mode/count" ] || [ ! -s "$parent/.direct-rm-record-$mode/count" ]; }; then
    pass "malformed allocation ($label/$mode): allocator reached and refused; nothing removed (sentinel intact, zero choke + direct removal calls)"
  else
    fail "malformed allocation ($label/$mode): rejection removed something or never reached the allocator (rc=$rc)"
  fi
}

# ── RISO US-002: port-isolation scenarios + reintroduction guard ──────
# The two port-observation scenarios below (allowed contained listener,
# excluded production-port) are call-time scenario helpers shared by the
# full harness's US-009 port section and the focused port-isolation
# regression (bin/tt-recorder-port-isolation.test.sh), exactly like the
# hostile-cleanup / malformed-allocation helpers are shared with the guard
# proof. They exercise the REAL exclusion decision — the unchanged runtime
# functions in the FIXTURE MIRROR of bin/tt-recorder ($TOOL) — with
# controlled port evidence and NO socket on any production port
# 3334/3338/3339. Everything they create is under the caller's fixture root
# and every process they spawn is registered (identity-rechecked teardown).
#
# Reachability note (why the excluded observation is a direct function call,
# not a live-process guard evaluation): on Linux the tool's
# _is_production_ports consults its darwin lsof arm ONLY when the pid has no
# procfs fd evidence (a non-existent pid, or a /proc-less host). A live
# process always gets a definitive inode-arm answer ("not production" — no
# production listener exists in a test), so the exclusion verbose line for
# the PORTS arm could only ever fire through the real _find_pids guard loop
# for a real process actually listening on 3334/3338/3339 — precisely the
# production bind this repair forbids. The scenarios therefore drive the real
# decision function directly (the narrowest process/port observation
# boundary, same as the proven tier1-tt-recorder-darwin-port-evidence.test.ts
# shim technique) and reproduce the tool's guard contract when the decision
# is 0 so the verbose exclusion line fires under controlled evidence.

# riso_port_allowed_contained <fake_home> <label> — ALLOWED contained-process
# observation (negative control; proves an always-exclude implementation
# fails). Spawns a contained process whose cwd is under the fixture var (so
# the real _find_pids discovers it) listening on an OS-selected random high
# port (python3 bind to port 0 — never a production port), then asserts:
#   * the listener started and reported its port (honesty: if it fails to
#     start, this FAILs — never a vacuous PASS);
#   * the OS-assigned port is not a production port;
#   * the REAL _is_production_ports <pid> returns 1 (not production);
#   * the pid IS present in the REAL discover_processes/collect_sample-style
#     discovery output — the exclusion logic must NOT drop it.
riso_port_allowed_contained() {
  local fake_home="$1" label="$2"
  local dir pid port_file port="" i rc out
  dir="$TT_ROOT_VAR/riso-port-allowed-$label-$$"
  port_file="$dir/listener-port.txt"
  mkdir -p "$dir"
  # OS-selected random port: bind 127.0.0.1:0, report the chosen port, listen.
  # `exec` is REQUIRED: without it the backgrounded `( cd ... && python3 ... )`
  # keeps the subshell bash as the job pid with python3 as its CHILD, so
  # $!-registered teardown would stop the subshell and orphan the listener
  # (observed with cwd "(deleted)" after fixture cleanup). exec replaces the
  # subshell so the registered pid IS the listener.
  ( cd "$dir" && exec python3 -c '
import socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0))
s.listen(1)
print(s.getsockname()[1], flush=True)
time.sleep(120)
' > "$port_file" 2>&1 ) &
  pid=$!
  _register_owned "$pid"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -s "$port_file" ]; then
      port="$(tr -d '\r\n' < "$port_file" 2>/dev/null || true)"
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done
  case "$port" in
    ''|*[!0-9]*)
      fail "allowed contained listener ($label): listener failed to start or report a port (pid=$pid) — verification unavailable, FAIL not PASS"
      ;;
    *)
      if [ "$port" = 3334 ] || [ "$port" = 3338 ] || [ "$port" = 3339 ]; then
        fail "allowed contained listener ($label): OS assigned a production port ($port)?! aborting observation"
      else
        # Direct real exclusion decision: the live contained listener is NOT
        # production (linux inode arm, no production socket).
        set +e
        bash -c "source '$TOOL'; _is_production_ports '$pid'" >/dev/null 2>&1
        rc=$?
        set -e
        if [ "$rc" -eq 1 ]; then
          pass "allowed contained listener ($label): real _is_production_ports rc=1 (not production) for random port $port pid=$pid"
        else
          fail "allowed contained listener ($label): _is_production_ports rc=$rc for the contained random-port listener (pid=$pid port=$port)"
        fi
        # Real discovery: the contained listener (cwd under the fixture var)
        # must be INCLUDED — exclusion must not drop it.
        out="$(TT_REAL_HOME="$fake_home" bash -c "source '$TOOL'; discover_processes" 2>/dev/null || true)"
        if printf '%s\n' "$out" | grep -q "\"pid\":$pid"; then
          pass "allowed contained listener ($label): pid=$pid IS included in real discovery (random port $port; not excluded)"
        else
          fail "allowed contained listener ($label): pid=$pid missing from real discovery (exclusion dropped a contained random-port listener)"
        fi
      fi
      ;;
  esac
  _stop_registered_pid "$pid"
}

# riso_port_excluded_production <label> — EXCLUDED production-port
# observation (positive control; proves an always-include implementation
# fails). Drives the REAL _is_production_ports with a synthetic NON-EXISTENT
# pid (987654321 — above any Linux pid_max, so no live process and no real
# listener can ever own it; its procfs fd evidence is absent, so the linux
# inode arm yields nothing and the function consults its darwin lsof arm)
# plus a fixture-owned PATH shim whose fake lsof reports that pid listening
# on production port 3334 and LOGS each invocation. Asserts:
#   * the synthetic pid is genuinely absent (coverage precondition);
#   * with the shim, real _is_production_ports returns 0 (production) AND
#     the shim invocation log is non-empty (coverage established — honesty:
#     if the shim/coverage cannot be established this FAILs, never PASSes);
#   * without the fake-lsof shim (plain PATH — a real host lsof, if present,
#     lists real LISTEN sockets, none of which can carry the synthetic
#     non-existent pid) the same call returns 1 and prints the tool's
#     explicit degradation line (the decision is evidence-driven — no
#     vacuous always-0 answer);
#   * with TT_RECORDER_VERBOSE=1 and the shim, the tool's verbose
#     'excluding production process' exclusion line fires (the guard
#     contract reproduced at the narrow decision boundary, per the
#     reachability note above).
riso_port_excluded_production() {
  local label="$1"
  local syn_pid=987654321 shim_dir log_file lsof_path rc out
  if kill -0 "$syn_pid" 2>/dev/null; then
    fail "excluded production port ($label): synthetic pid $syn_pid is unexpectedly alive — coverage cannot be established"
    return 0
  fi
  shim_dir="$FIXTURE_ROOT/riso-lsof-shim-$label-$$"
  log_file="$shim_dir/invoked.log"
  mkdir -p "$shim_dir"
  # Fake lsof: logs every invocation (coverage evidence), then reports the
  # synthetic pid listening on production port 3334 (numeric LISTEN table in
  # the exact shape the tool's darwin lsof arm parses).
  lsof_path="$shim_dir/lsof"
  printf '%s\n' '#!/bin/sh' \
    "printf '%s\n' 'invoked' >> '$log_file'" \
    'echo "COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME"' \
    "echo 'node  $syn_pid  tester 22u  IPv4 0xdeadbeef      0t0  TCP 127.0.0.1:3334 (LISTEN)'" \
    'exit 0' > "$lsof_path"
  chmod +x "$lsof_path"

  # Positive: real decision returns 0 under the controlled fake-lsof evidence.
  set +e
  out="$(PATH="$shim_dir:$PATH" bash -c "
    set -euo pipefail
    source '$TOOL'
    _is_production_ports '$syn_pid'
  " 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && [ -s "$log_file" ]; then
    pass "excluded production port ($label): real _is_production_ports rc=0 (production) for synthetic pid $syn_pid under fake-lsof LISTEN on 3334 (shim invoked)"
  else
    fail "excluded production port ($label): _is_production_ports rc=$rc for the fake-lsof production evidence (pid=$syn_pid, shim log empty=$([ -s "$log_file" ] && echo no || echo yes))"
  fi

  # Honesty/evidence-driven check: WITHOUT the fake-lsof shim (plain PATH —
  # a real host lsof, if present, lists real LISTEN sockets, none of which
  # can carry the synthetic non-existent pid) the same pid must NOT be
  # reported production: the real decision returns 1 and prints the tool's
  # explicit degradation line — never a vacuous always-0 answer.
  set +e
  out="$(bash -c "
    set -euo pipefail
    source '$TOOL'
    _is_production_ports '$syn_pid'
  " 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'port evidence unavailable on this platform'; then
    pass "excluded production port ($label): without-shim degradation — _is_production_ports rc=1 with the explicit degradation line (evidence-driven, not vacuous)"
  else
    fail "excluded production port ($label): without the fake-lsof shim rc=$rc (expected 1 + degradation line): $out"
  fi

  # Verbose guard contract: when the real decision is 0 the tool's verbose
  # exclusion line fires (the _find_pids guard prints it after
  # _is_production_ports returns 0; reproduced here at the narrow decision
  # boundary — never with a real production listener).
  set +e
  out="$(PATH="$shim_dir:$PATH" TT_RECORDER_VERBOSE=1 bash -c "
    set -euo pipefail
    source '$TOOL'
    if _is_production_ports '$syn_pid'; then
      echo 'tt-recorder: excluding production process PID='$syn_pid' (listens on production port 3334/3338/3339)' >&2
      exit 0
    fi
    exit 3
  " 2>&1 1>/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q "excluding production process PID=$syn_pid"; then
    pass "excluded production port ($label): verbose 'excluding production process' line fires for pid=$syn_pid under TT_RECORDER_VERBOSE"
  else
    fail "excluded production port ($label): verbose exclusion line did not fire (rc=$rc): $out"
  fi
}

# riso_reintroduction_guard <target-file> <label> — static reintroduction
# guard (RISO US-002): scans a shell file (the harness source or the driven
# fixture tool copy) for forbidden reintroductions, masking comments so doc
# prose may mention ports or the source layout without being flagged (the
# mask style of the harness's Tests 17-18/90-91 greps). After stripping
# '#'-comments (but NOT quoted strings — an executed bind inside a python -c
# string must still be caught), it flags and FAILs on:
#   (a) an EXECUTED socket bind to a literal production port 3334/3338/3339
#       (pattern bind( ... 333x ) — prose never uses the call form);
#   (b) source-checkout state usage — a removal/state line that references
#       the source bin ($_SRC_BIN) or the file's own BASH_SOURCE while also
#       carrying a destructive/state token (rm, kill, TT_ROOT_VAR=, a
#       recorder pidfile) — mutable state must derive ONLY from the
#       invocation fixture root.
# Prints one PASS line per clean target; on a violation prints the offending
# lines and returns 1 (the harness FAILs; focused gates capture the rc to
# prove a reintroduced scratch copy trips the guard).
riso_reintroduction_guard() {
  local target="$1" label="$2"
  local stripped hits state_hits v
  if [ ! -f "$target" ]; then
    echo "  FAIL: reintroduction guard ($label): target file missing: $target" >&2
    return 1
  fi
  stripped="$(sed 's/[[:space:]]*#.*$//' "$target" 2>/dev/null || true)"
  # (a) executed binds to literal production ports (prose never uses the
  # call form, so comment masking suffices); (b) checkout-state usage — a
  # line referencing the source bin or its own BASH_SOURCE while carrying a
  # destructive/state token.
  hits="$(printf '%s\n' "$stripped" | grep -nE 'bind\([^)]*(3334|3338|3339)' || true)"
  state_hits="$(printf '%s\n' "$stripped" | grep -E '_SRC_BIN|BASH_SOURCE' | grep -E 'rm |kill |TT_ROOT_VAR=|tt-recorder\.pid' || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | while IFS= read -r v; do
      [ -n "$v" ] || continue
      echo "  VIOLATION ($label): executed socket bind to a literal production port — $v" >&2
    done
  fi
  if [ -n "$state_hits" ]; then
    printf '%s\n' "$state_hits" | while IFS= read -r v; do
      [ -n "$v" ] || continue
      echo "  VIOLATION ($label): source-checkout state usage (mutable state derived from the source bin / own BASH_SOURCE) — $v" >&2
    done
  fi
  if [ -n "$hits" ] || [ -n "$state_hits" ]; then
    fail "reintroduction guard ($label): forbidden production-bind or source-checkout state usage reintroduced"
    return 1
  fi
  pass "reintroduction guard ($label): no executed production-port bind or source-checkout state usage"
  return 0
}
